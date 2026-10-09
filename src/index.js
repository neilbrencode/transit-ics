// Sound Transit alerts -> iCalendar feed (Cloudflare Worker, no dependencies)
//
// GET /transit.ics                    -> 2 Line alerts (default)
// GET /transit.ics?routes=2LINE,100479 -> 2 Line + 1 Line
//
// Source: Sound Transit's public GTFS-Realtime alerts feed (JSON form).
// The Worker is stateless: Outlook matches events by UID, so an alert that
// disappears from the feed disappears from the calendar on the next refresh.

const FEED_URL = "https://s3.amazonaws.com/st-service-alerts-prod/alerts_pb.json";
const DEFAULT_ROUTES = ["2LINE"];
const ROUTE_ID = /^[A-Za-z0-9_]{1,32}$/;
const MAX_ROUTES = 10;
const TZ = "America/Los_Angeles";
const CACHE_SECONDS = 300; // cache the upstream feed at Cloudflare's edge for 5 min
// Periods longer than this become all-day events (a banner across the top of
// the calendar) instead of a block covering every hour of every day.
const ALL_DAY_THRESHOLD_HOURS = 24;
// Link runs past midnight, so "until end of service Sunday" arrives as ~2:30 a.m.
// Monday. Treat end times before this hour as the previous service day.
const SERVICE_DAY_ROLLOVER_HOURS = 4;

export default {
  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname !== "/transit.ics") {
      return new Response("Not found", { status: 404 });
    }

    // Route ids are echoed into X-WR-CALNAME. Reject anything that could inject
    // lines, and bound the size so a huge query can't burn the CPU budget.
    // (The decoded value is capped before splitting; Cloudflare's URL size
    // limit bounds the parsing that happens before this.)
    const param = url.searchParams.get("routes") || DEFAULT_ROUTES.join(",");
    const routes = param.length > MAX_ROUTES * 33 /* 32 chars + comma */ ? [] : param
      .split(",")
      .map((r) => r.trim())
      .filter(Boolean);
    if (!routes.length || routes.length > MAX_ROUTES || !routes.every((r) => ROUTE_ID.test(r))) {
      return new Response("Invalid routes", { status: 400 });
    }

    const upstream = await fetch(FEED_URL, {
      cf: { cacheTtl: CACHE_SECONDS, cacheEverything: true },
    });
    if (!upstream.ok) {
      // Fail loudly rather than serving an empty calendar, which would make
      // Outlook delete every existing event.
      return new Response(`Upstream feed error: ${upstream.status}`, { status: 502 });
    }

    const feed = await upstream.json();
    const body = buildCalendar(feed, routes);
    return new Response(body, {
      headers: {
        "content-type": "text/calendar; charset=utf-8",
        "cache-control": `public, max-age=${CACHE_SECONDS}`,
      },
    });
  },
};

export function buildCalendar(feed, routes, now = Math.floor(Date.now() / 1000)) {
  const wanted = new Set(routes);
  const stamp = toUtcStamp(feed.header?.timestamp ?? now);
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//transit-ics//Sound Transit alerts//EN",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    `X-WR-CALNAME:Transit (${routes.join(", ")})`,
    `X-WR-TIMEZONE:${TZ}`,
    "REFRESH-INTERVAL;VALUE=DURATION:PT1H",
    "X-PUBLISHED-TTL:PT1H",
  ];

  for (const entity of feed.entity ?? []) {
    const alert = entity.alert;
    if (!alert) continue;
    const alertRoutes = new Set((alert.informed_entity ?? []).map((e) => e.route_id));
    if (![...alertRoutes].some((r) => wanted.has(r))) continue;

    const summary = text(alert.header_text) || "Sound Transit alert";
    const link = singleLine(text(alert.url));
    const id = uidSafe(String(entity.id));
    const description = [text(alert.description_text), link].filter(Boolean).join("\n\n");
    const periods = alert.active_period?.length ? alert.active_period : [{}];

    periods.forEach((p, i) => {
      const start = p.start ?? now;
      // Open-ended ("until further notice"): a banner from start through today.
      // It extends by a day on each refresh and vanishes when ST clears the alert.
      const openEnded = p.end == null;
      const end = openEnded ? Math.max(start, now) : p.end;
      const allDay = openEnded || (end - start) / 3600 > ALL_DAY_THRESHOLD_HOURS;

      lines.push("BEGIN:VEVENT");
      lines.push(`UID:st-alert-${id}-${i}@transit-ics`);
      lines.push(`DTSTAMP:${stamp}`);
      if (allDay) {
        lines.push(`DTSTART;VALUE=DATE:${toLocalDate(start)}`);
        // DTEND is exclusive for all-day events, so use the day after the end date
        const serviceDayEnd = Math.max(start, end - SERVICE_DAY_ROLLOVER_HOURS * 3600);
        lines.push(`DTEND;VALUE=DATE:${toLocalDate(serviceDayEnd, 1)}`);
      } else {
        lines.push(`DTSTART:${toUtcStamp(start)}`);
        lines.push(`DTEND:${toUtcStamp(end)}`);
      }
      lines.push(`SUMMARY:${escape((openEnded ? "[Ongoing] " : "") + summary)}`);
      if (description) lines.push(`DESCRIPTION:${escape(description)}`);
      if (link) lines.push(`URL:${link}`);
      lines.push(`CATEGORIES:${escape([...alertRoutes].join(","))}`);
      lines.push("TRANSP:TRANSPARENT"); // don't mark you as busy
      lines.push("END:VEVENT");
    });
  }

  lines.push("END:VCALENDAR");
  return lines.map(fold).join("\r\n") + "\r\n";
}

// --- helpers ---------------------------------------------------------------

function text(translated) {
  const t = translated?.translation ?? [];
  return (t.find((x) => x.language === "en") ?? t[0])?.text?.trim() ?? "";
}

function toUtcStamp(epochSeconds) {
  return new Date(epochSeconds * 1000).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
}

// YYYYMMDD in Pacific time, optionally shifted by whole days
function toLocalDate(epochSeconds, addDays = 0) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(new Date(epochSeconds * 1000));
  const get = (type) => Number(parts.find((p) => p.type === type).value);
  const d = new Date(Date.UTC(get("year"), get("month") - 1, get("day") + addDays));
  return d.toISOString().slice(0, 10).replace(/-/g, "");
}

// UID-safe id: escape each UTF-16 code unit outside [A-Za-z0-9._~-] as a
// fixed-width %xxxx. Never throws (even on lone surrogates), can't inject lines,
// and is collision-free because "%" itself is escaped. Plain ids (ST's are
// numeric) pass through unchanged, keeping existing UIDs stable.
function uidSafe(s) {
  return s.replace(/[^A-Za-z0-9._~-]/g, (c) => `%${c.charCodeAt(0).toString(16).padStart(4, "0")}`);
}

// For the unescaped URL property: drop line breaks so feed data can't add lines
function singleLine(s) {
  return s.replace(/[\r\n]/g, "");
}

// RFC 5545 text escaping
function escape(s) {
  return s
    .replace(/\r\n|\r/g, "\n")
    .replace(/\\/g, "\\\\")
    .replace(/;/g, "\\;")
    .replace(/,/g, "\\,")
    .replace(/\n/g, "\\n");
}

// RFC 5545 line folding: max 75 octets per line, continuation lines start with a space
function fold(line) {
  const enc = new TextEncoder();
  if (enc.encode(line).length <= 75) return line;
  const out = [];
  let current = "";
  for (const ch of line) {
    const limit = out.length === 0 ? 75 : 74; // continuation lines lose 1 octet to the leading space
    if (enc.encode(current + ch).length > limit) {
      out.push(current);
      current = ch;
    } else {
      current += ch;
    }
  }
  out.push(current);
  return out.map((l, i) => (i === 0 ? l : " " + l)).join("\r\n");
}
