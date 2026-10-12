// Washington State Ferries (WSF) alerts -> iCalendar
//
// Source: the WSDOT Ferries Schedule API alerts operation (JSON). It has no
// start or end times, only a publish date, so each alert is an all-day banner
// from its publish date through today, for as long as WSF lists it (ADR 6).
// The access code travels in the upstream URL, so nothing on the error path
// echoes the URL, the upstream body or an exception, and nothing is logged (ADR 7).

import { CACHE_SECONDS, calendarHeader, calendarResponse, escape, finish, toLocalDate, toUtcStamp } from "./ical.js";

const ALERTS_URL = "https://www.wsdot.wa.gov/Ferries/API/Schedule/rest/alerts";
const ALERTS_PAGE = "https://wsdot.com/ferries/schedule/bulletin.aspx";
const ROUTE_ID = /^[1-9][0-9]{0,3}$/; // WSF route ids are small positive integers
const MAX_ROUTES = 10;
const MAX_ROUTES_PARAM = 50; // characters, checked before splitting
// Upstream ids: a positive integer, or a string of digits
const ID_STRING = /^[0-9]{1,15}$/;
// Dates outside this range can't come from a live bulletin; they get the
// bad-date fallback. The bounds also keep every derived date a valid
// four-digit iCalendar year.
const DATE_PATTERN = /^20[0-9]{6}$/; // YYYYMMDD in 2000-2099
const MIN_EPOCH_MS = 0;
const MAX_EPOCH_MS = Date.UTC(2200, 0, 1);

// GET /wsf.ics                     -> default routes (WSF_ROUTES)
// GET /wsf.ics?routes=5,3          -> Seattle/Bainbridge + Seattle/Bremerton
// GET /wsf.ics?allroutes=0         -> leave out notices WSF flags as all-routes
export async function handleFerries(url, env) {
  const param = url.searchParams.get("routes");
  const routes = parseRoutes(param || env.WSF_ROUTES);
  if (!routes) {
    return param
      ? new Response("Invalid routes", { status: 400 })
      : new Response("WSF routes misconfigured", { status: 500 });
  }

  const all = url.searchParams.get("allroutes");
  if (all !== null && all !== "0" && all !== "1") {
    return new Response("Invalid allroutes", { status: 400 });
  }
  const includeAllRoutes = all === null ? env.WSF_INCLUDE_ALL_ROUTES !== "false" : all === "1";

  const code = env.WSF_API_ACCESS_CODE;
  if (!code) return new Response("WSF access code not configured", { status: 500 });

  let body;
  try {
    const upstream = await fetch(`${ALERTS_URL}?apiaccesscode=${encodeURIComponent(code)}`, {
      headers: { accept: "application/json" }, // WSDOT defaults to XML
      cf: { cacheTtl: CACHE_SECONDS, cacheEverything: true },
    });
    const alerts = upstream.ok ? validateAlerts(await upstream.json()) : null;
    if (alerts) body = buildFerryCalendar(alerts, { routes, includeAllRoutes });
  } catch {
    // Fall through: the exception may carry the URL, so it is dropped
  }
  // Never an empty or partial calendar in place of real data (ADR 4)
  return body ? calendarResponse(body) : new Response("Upstream feed error", { status: 502 });
}

// "5,3,6" -> [5, 3, 6], or null if anything is off
export function parseRoutes(param) {
  if (typeof param !== "string" || param.length > MAX_ROUTES_PARAM) return null;
  const ids = param.split(",").map((r) => r.trim()).filter(Boolean);
  if (!ids.length || ids.length > MAX_ROUTES || !ids.every((r) => ROUTE_ID.test(r))) return null;
  return ids.map(Number);
}

// Checks every row before any filtering, so a schema change fails the whole
// response instead of quietly dropping alerts. Returns null if any row is
// malformed; field-level gaps (date, text) are tolerated later.
export function validateAlerts(data) {
  if (!Array.isArray(data)) return null;
  const alerts = [];
  for (const row of data) {
    if (row === null || typeof row !== "object" || Array.isArray(row)) return null;
    const id = positiveId(row.BulletinID);
    if (id === null || typeof row.AllRoutesFlag !== "boolean" || !("AffectedRouteIDs" in row)) return null;
    const routeIds = row.AffectedRouteIDs ?? [];
    if (!Array.isArray(routeIds)) return null;
    const normalised = routeIds.map(positiveId);
    if (normalised.includes(null)) return null;
    alerts.push({ id: String(id), allRoutes: row.AllRoutesFlag, routeIds: normalised, row });
  }
  return alerts;
}

function positiveId(v) {
  const n = typeof v === "string" && ID_STRING.test(v) ? Number(v) : v;
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

export function buildFerryCalendar(alerts, { routes, includeAllRoutes }, now = Math.floor(Date.now() / 1000)) {
  const wanted = new Set(routes);
  const stamp = toUtcStamp(now);
  const lines = calendarHeader("-//transit-ics//WSF alerts//EN", "Ferries");
  const seen = new Set();

  for (const alert of alerts) {
    if (seen.has(alert.id)) continue; // first row wins, so UIDs stay unique
    seen.add(alert.id);
    // WSF's own flag decides all-routes notices, whatever routes they also list
    const include = alert.allRoutes ? includeAllRoutes : alert.routeIds.some((r) => wanted.has(r));
    if (!include) continue;

    const { row } = alert;
    const [start, end] = bannerDates(parseWsfDate(row.PublishDate), now);
    const title = plain(row.AlertFullTitle) || plain(row.RouteAlertText) || "WSF alert";
    const detail = htmlToText(row.BulletinText) || htmlToText(row.HomepageAlertText) || plain(row.RouteAlertText);

    lines.push("BEGIN:VEVENT");
    lines.push(`UID:wsf-alert-${alert.id}@transit-ics`);
    lines.push(`DTSTAMP:${stamp}`);
    lines.push(`DTSTART;VALUE=DATE:${start}`);
    lines.push(`DTEND;VALUE=DATE:${end}`); // exclusive
    lines.push(`SUMMARY:${escape(`⛴ [Ongoing] ${title}`)}`);
    lines.push(`DESCRIPTION:${escape([detail, ALERTS_PAGE].filter(Boolean).join("\n\n"))}`);
    lines.push(`URL:${ALERTS_PAGE}`);
    lines.push("TRANSP:TRANSPARENT"); // don't mark you as busy
    lines.push("END:VEVENT");
  }

  return finish(lines);
}

// All-day banner from the publish date through today (DTEND exclusive). A
// future publish date gets one day. A missing or out-of-range date gets today.
function bannerDates(published, now) {
  if (published !== null) {
    const start = toLocalDate(published);
    const end = toLocalDate(Math.max(published, now), 1);
    if (DATE_PATTERN.test(start) && DATE_PATTERN.test(end)) return [start, end];
  }
  return [toLocalDate(now), toLocalDate(now, 1)];
}

// "/Date(1791825236330-0700)/" -> epoch seconds. The number is UTC
// milliseconds; the offset is display-only. Null if malformed or absurd.
export function parseWsfDate(s) {
  const m = typeof s === "string" && /^\/Date\((-?[0-9]{1,16})([+-][0-9]{4})?\)\/$/.exec(s);
  if (!m) return null;
  const ms = Number(m[1]);
  return ms >= MIN_EPOCH_MS && ms < MAX_EPOCH_MS ? Math.floor(ms / 1000) : null;
}

const NAMED = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ",
  lsquo: "‘", rsquo: "’", ldquo: "“", rdquo: "”", ndash: "–", mdash: "—", hellip: "…",
};

function decode(s) {
  return s.replace(/&(#x[0-9a-f]+|#[0-9]+|[a-z]+);/gi, (match, ref) => {
    if (ref[0] !== "#") return NAMED[ref.toLowerCase()] ?? match;
    const cp = ref[1] === "x" || ref[1] === "X" ? parseInt(ref.slice(2), 16) : parseInt(ref.slice(1), 10);
    return cp <= 0x10ffff ? String.fromCodePoint(cp) : "�";
  });
}

// Plain-text field: no tags expected, but decode entities and tidy spaces
function plain(s) {
  return typeof s === "string" ? tidy(decode(s.replace(/<[^>]*>/g, ""))) : "";
}

// Bulletin HTML -> readable plain text: one line per paragraph or list item,
// list items as "- ", links as "text (url)"
export function htmlToText(html) {
  if (typeof html !== "string") return "";
  const text = html
    .replace(/<a\b[^>]*?\bhref\s*=\s*(["'])(.*?)\1[^>]*>([\s\S]*?)<\/a>/gi, (_, _q, href, inner) => {
      const label = inner.replace(/<[^>]*>/g, "").trim();
      return label && label !== href ? `${label} (${href})` : href;
    })
    .replace(/<li\b[^>]*>/gi, "\n- ")
    .replace(/<\/?(?:p|div|br|ul|ol|li|h[1-6]|tr|table)\b[^>]*>/gi, "\n")
    .replace(/<[^>]*>/g, "");
  return tidy(decode(text));
}

// Collapse runs of spaces within lines; drop blank lines
function tidy(s) {
  return s
    .split(/\r\n|\r|\n/)
    .map((line) => line.replace(/[ \t ]+/g, " ").trim())
    .filter(Boolean)
    .join("\n");
}
