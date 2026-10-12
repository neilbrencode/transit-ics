// iCalendar helpers shared by every feed (RFC 5545)

export const TZ = "America/Los_Angeles";
export const CACHE_SECONDS = 300; // cache upstream feeds at Cloudflare's edge for 5 min

export function calendarResponse(body) {
  return new Response(body, {
    headers: {
      "content-type": "text/calendar; charset=utf-8",
      "cache-control": `public, max-age=${CACHE_SECONDS}`,
    },
  });
}

// VCALENDAR header lines; feeds push VEVENTs after these, then call finish()
export function calendarHeader(prodId, name) {
  return [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    `PRODID:${prodId}`,
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    `X-WR-CALNAME:${name}`,
    `X-WR-TIMEZONE:${TZ}`,
    "REFRESH-INTERVAL;VALUE=DURATION:PT1H",
    "X-PUBLISHED-TTL:PT1H",
  ];
}

// Close the calendar, fold every line and join with CRLF
export function finish(lines) {
  lines.push("END:VCALENDAR");
  return lines.map(fold).join("\r\n") + "\r\n";
}

export function toUtcStamp(epochSeconds) {
  return new Date(epochSeconds * 1000).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
}

// YYYYMMDD in Pacific time, optionally shifted by whole days
export function toLocalDate(epochSeconds, addDays = 0) {
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
export function uidSafe(s) {
  return s.replace(/[^A-Za-z0-9._~-]/g, (c) => `%${c.charCodeAt(0).toString(16).padStart(4, "0")}`);
}

// For the unescaped URL property: drop line breaks so feed data can't add lines
export function singleLine(s) {
  return s.replace(/[\r\n]/g, "");
}

// RFC 5545 text escaping
export function escape(s) {
  return s
    .replace(/\r\n|\r/g, "\n")
    .replace(/\\/g, "\\\\")
    .replace(/;/g, "\\;")
    .replace(/,/g, "\\,")
    .replace(/\n/g, "\\n");
}

// RFC 5545 line folding: max 75 octets per line, continuation lines start with a space
export function fold(line) {
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
