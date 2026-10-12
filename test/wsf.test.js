// Washington State Ferries feed. Run: npm test   (node --test, no framework)
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import ICAL from "ical.js";
import worker from "../src/index.js";
import { buildFerryCalendar, htmlToText, parseRoutes, parseWsfDate, validateAlerts } from "../src/wsf.js";

// Real payload from the WSDOT alerts operation, 2026-10-12 (two live alerts)
const fixture = JSON.parse(readFileSync(new URL("./fixture-wsf-2026-10-12.json", import.meta.url)));
const NOW = 1791838201; // 2026-10-12 13:50 PT, when the fixture was captured
const PAGE = "https://wsdot.com/ferries/schedule/bulletin.aspx";

// Epoch seconds for a Pacific wall-clock time, given its UTC offset in hours
const pt = (y, mo, d, h, mi, offset) => Date.UTC(y, mo - 1, d, h - offset, mi) / 1000;
const wsfDate = (seconds, offset = "-0700") => `/Date(${seconds * 1000}${offset})/`;

function events(ics) {
  const comp = new ICAL.Component(ICAL.parse(ics)); // throws on malformed ICS
  return comp.getAllSubcomponents("vevent").map((v) => new ICAL.Event(v));
}

function render(alerts, { routes = [6, 9], includeAllRoutes = true, now = NOW } = {}) {
  const valid = validateAlerts(alerts);
  assert.ok(valid, "alerts should validate");
  return buildFerryCalendar(valid, { routes, includeAllRoutes }, now);
}
const uids = (ics) => events(ics).map((e) => e.uid).sort();
const only = (ics) => {
  const evs = events(ics);
  assert.equal(evs.length, 1);
  return evs[0];
};

// SYNTHETIC alert, shaped like the real rows, for cases the live feed didn't have
const row = (fields = {}) => ({
  BulletinID: 900001,
  BulletinText: "<p>Synthetic bulletin.</p>",
  HomepageAlertText: null,
  RouteAlertText: "Synthetic route alert",
  PublishDate: wsfDate(pt(2026, 10, 10, 9, 0, -7)),
  AllRoutesFlag: false,
  AlertFullTitle: "Synthetic alert",
  AffectedRouteIDs: [6],
  ...fields,
});

// --- real fixture ----------------------------------------------------------

test("route 6 gets the Kingston alert, 9 the San Juans one, 5 and 3 nothing", () => {
  assert.deepEqual(uids(render(fixture, { routes: [6] })), ["wsf-alert-113728@transit-ics"]);
  assert.deepEqual(uids(render(fixture, { routes: [9] })), ["wsf-alert-119049@transit-ics"]);
  assert.deepEqual(uids(render(fixture, { routes: [5, 3] })), []);
});

test("Kingston alert is a banner from its Aug 30 publish date through today", () => {
  const e = only(render(fixture, { routes: [6] }));
  assert.equal(e.startDate.isDate, true);
  assert.equal(e.startDate.toString(), "2026-08-30");
  assert.equal(e.endDate.toString(), "2026-10-13"); // exclusive => shows through Oct 12
  assert.equal(e.summary, "⛴ [Ongoing] Edm/King - Boarding pass required daily, 8 a.m. to 8 p.m. through Oct.12");
  assert.equal(e.component.getFirstPropertyValue("url"), PAGE);
  assert.equal(e.component.getFirstPropertyValue("transp"), "TRANSPARENT");
  assert.equal(e.component.getFirstPropertyValue("last-modified"), null);
});

test("Kingston bulletin HTML becomes readable text: lines, list items and links", () => {
  const html = fixture.find((a) => a.BulletinID === 113728).BulletinText;
  const lines = htmlToText(html).split("\n");
  assert.equal(lines.length, 11);
  assert.equal(
    lines[0],
    "The traffic signal and boarding pass system (https://wsdotblog.blogspot.com/2026/04/smoother-sailing-in-kingston-new-sr-104.html) at the Kingston terminal is active daily from 8 a.m. to 8 p.m. through Indigenous Peoples’ Day on Oct. 12. The boarding pass holds your vehicle's place in line. Ferry tickets are purchased separately.",
  );
  assert.equal(lines[1], "A boarding pass for vehicles is required before arriving at the terminal ticket booth");
  assert.match(lines[2], /^- Follow the signal: .* View map \(https:\/\/blogger\.googleusercontent\.com\/.*Kingston-ATMS-Map\.gif\)\.$/);
  assert.equal(lines[3], "- Take a pass: Stop at the automated dispenser and take your pass. If you leave the line after taking a pass, you will need to re-enter the line and take a new pass.");
  assert.equal(lines[8], "- Year-Round: Every Saturday and Sunday.");
  for (const line of lines) assert.ok(!/[<>]|&quot;|&amp;|data-ccp/.test(line), line);
});

test("description is the bulletin text then the WSF alerts page", () => {
  const e = only(render(fixture, { routes: [9] }));
  assert.equal(
    e.description,
    `The elevator on the M/V Yakima is back in service and available for customer use.\n\n${PAGE}`,
  );
});

test("WSF output folds to <= 75 octets with CRLF only", () => {
  const ics = render(fixture);
  assert.ok(!/[^\r]\n/.test(ics), "bare LF found");
  for (const line of ics.split("\r\n")) assert.ok(Buffer.byteLength(line) <= 75, `too long: ${line}`);
  assert.equal(events(ics).length, 2);
});

// --- filtering (synthetic rows) ----------------------------------------------

test("unknown-only, empty and null route lists match no route", () => {
  const alerts = [
    row({ BulletinID: 1, AffectedRouteIDs: [272] }),
    row({ BulletinID: 2, AffectedRouteIDs: [] }),
    row({ BulletinID: 3, AffectedRouteIDs: null }),
  ];
  assert.deepEqual(uids(render(alerts, { routes: [5, 3, 6, 9] })), []);
});

test("all-routes notices follow the all-routes switch, whatever routes they list", () => {
  const alerts = [
    row({ BulletinID: 1, AllRoutesFlag: true, AffectedRouteIDs: [] }),
    row({ BulletinID: 2, AllRoutesFlag: true, AffectedRouteIDs: [6] }),
  ];
  assert.deepEqual(uids(render(alerts, { routes: [5], includeAllRoutes: true })),
    ["wsf-alert-1@transit-ics", "wsf-alert-2@transit-ics"]);
  assert.deepEqual(uids(render(alerts, { routes: [6], includeAllRoutes: false })), []);
});

test("string ids normalise: \"6\" matches route 6 and \"119049\" is the same UID as 119049", () => {
  const ics = render([row({ BulletinID: "119049", AffectedRouteIDs: ["6"] })], { routes: [6] });
  assert.deepEqual(uids(ics), ["wsf-alert-119049@transit-ics"]);
});

test("duplicate bulletin ids give one event, the first row", () => {
  const ics = render([row({ AlertFullTitle: "First" }), row({ AlertFullTitle: "Second" })]);
  assert.equal(only(ics).summary, "⛴ [Ongoing] First");
});

// --- dates -------------------------------------------------------------------

test("PublishDate is UTC milliseconds; the offset is display-only", () => {
  const summer = pt(2026, 7, 1, 9, 30, -7);
  const winter = pt(2026, 12, 2, 0, 0, -8);
  assert.equal(parseWsfDate(wsfDate(summer, "-0700")), summer);
  assert.equal(parseWsfDate(wsfDate(winter, "-0800")), winter);
  assert.equal(parseWsfDate(wsfDate(winter, "")), winter);
  for (const bad of [null, 5, "", "2026-10-12", "/Date(abc)/", "/Date(1791825236330-0700)", "/Date(-1-0700)/",
    "/Date(9999999999999999-0700)/"]) {
    assert.equal(parseWsfDate(bad), null, String(bad));
  }
});

test("banner ends after Pacific today at midnight, before 4 a.m., late night and across DST", () => {
  const published = row({ PublishDate: wsfDate(pt(2026, 3, 1, 12, 0, -8)) });
  for (const [now, end] of [
    [pt(2026, 10, 13, 0, 0, -7) + 30, "2026-10-14"], // 00:00:30
    [pt(2026, 10, 13, 3, 59, -7), "2026-10-14"], // no 4 a.m. service-day rollover
    [pt(2026, 10, 12, 23, 59, -7), "2026-10-13"],
    [pt(2026, 3, 8, 0, 30, -8), "2026-03-09"], // DST starts 2 a.m. Mar 8
    [pt(2026, 3, 8, 3, 30, -7), "2026-03-09"],
    [pt(2026, 11, 1, 0, 30, -7), "2026-11-02"], // DST ends 2 a.m. Nov 1
    [pt(2026, 11, 1, 23, 30, -8), "2026-11-02"],
  ]) {
    const e = only(render([published], { now }));
    assert.equal(e.startDate.toString(), "2026-03-01");
    assert.equal(e.endDate.toString(), end, new Date(now * 1000).toISOString());
  }
});

test("same bulletin on consecutive days keeps its UID and start; the end advances", () => {
  const [a, b] = [NOW, NOW + 86400].map((now) => only(render(fixture, { routes: [6], now })));
  assert.equal(a.uid, b.uid);
  assert.equal(a.startDate.toString(), b.startDate.toString());
  assert.equal(a.endDate.toString(), "2026-10-13");
  assert.equal(b.endDate.toString(), "2026-10-14");
});

test("a future publish date is a single-day event on that date", () => {
  const e = only(render([row({ PublishDate: wsfDate(pt(2026, 10, 20, 9, 0, -7)) })]));
  assert.equal(e.startDate.toString(), "2026-10-20");
  assert.equal(e.endDate.toString(), "2026-10-21");
});

test("dates must stay within 2000-2099, including the exclusive end", () => {
  const dated = (y, mo, d) => only(render([row({ PublishDate: wsfDate(pt(y, mo, d, 12, 0, -8)) })]));
  assert.equal(dated(2000, 1, 1).startDate.toString(), "2000-01-01");
  assert.equal(dated(2099, 12, 30).endDate.toString(), "2099-12-31");
  for (const [y, mo, d] of [[1999, 12, 31], [2100, 1, 1], [2099, 12, 31]]) {
    const e = dated(y, mo, d);
    assert.equal(e.startDate.toString(), "2026-10-12", `${y}-${mo}-${d} should fall back to today`);
    assert.equal(e.endDate.toString(), "2026-10-13");
  }
});

test("a bad publish date gives a one-day banner on whichever day it renders", () => {
  for (const [now, day, next] of [[NOW, "2026-10-12", "2026-10-13"], [NOW + 86400, "2026-10-13", "2026-10-14"]]) {
    const e = only(render([row({ PublishDate: "garbage" })], { now }));
    assert.equal(e.startDate.toString(), day);
    assert.equal(e.endDate.toString(), next);
  }
});

// --- text ----------------------------------------------------------------------

test("entities decode, including numeric newlines, without breaking iCalendar lines", () => {
  const ics = render([row({
    AlertFullTitle: "Sea/Bi &amp; Sea/Br &#8211; cancelled",
    BulletinText: "<p>Line one&#10;BEGIN:VEVENT &lt;b&gt; &quot;q&quot; &#x2019; &unknown;</p>",
  })]);
  const e = only(ics);
  assert.equal(e.summary, "⛴ [Ongoing] Sea/Bi & Sea/Br – cancelled");
  assert.equal(e.description, `Line one\nBEGIN:VEVENT <b> "q" ’ &unknown;\n\n${PAGE}`);
  assert.equal((ics.match(/^BEGIN:VEVENT/gm) ?? []).length, 1);
});

test("hostile title and text with CR/LF, commas and semicolons can't inject lines", () => {
  const ics = render([row({
    AlertFullTitle: "a,b;c\r\nSUMMARY:pwned",
    BulletinText: "x\r\nEND:VEVENT\nBEGIN:VEVENT",
  })]);
  const e = only(ics);
  assert.equal(e.summary, "⛴ [Ongoing] a,b;c\nSUMMARY:pwned");
  assert.ok(!/^SUMMARY:pwned/m.test(ics));
  assert.ok(!/^END:VEVENT\r\nBEGIN:VEVENT\r\n(?!UID)/m.test(ics));
});

test("empty bulletin text falls back to the homepage alert HTML", () => {
  const e = only(render([row({ BulletinText: "", HomepageAlertText: "<p>Homepage &amp; <b>detail</b></p><ul><li>one</li></ul>" })]));
  assert.equal(e.description, `Homepage & detail\n- one\n\n${PAGE}`);
});

test("missing text falls back: route alert text, then a generic title", () => {
  let e = only(render([row({ AlertFullTitle: null, BulletinText: null })]));
  assert.equal(e.summary, "⛴ [Ongoing] Synthetic route alert");
  assert.equal(e.description, `Synthetic route alert\n\n${PAGE}`);
  e = only(render([row({ AlertFullTitle: "", RouteAlertText: null, BulletinText: null })]));
  assert.equal(e.summary, "⛴ [Ongoing] WSF alert");
  assert.equal(e.description, PAGE);
});

// --- validation ------------------------------------------------------------------

test("structural problems invalidate the whole response", () => {
  const good = row();
  const { AffectedRouteIDs: _, ...noRoutes } = good;
  for (const [name, data] of [
    ["object, not array", { Message: "error" }],
    ["error row", [{ Message: "error" }]],
    ["non-object row", [good, 5]],
    ["null row", [null]],
    ["array row", [[good]]],
    ["missing id", [{ ...good, BulletinID: undefined }]],
    ["zero id", [row({ BulletinID: 0 })]],
    ["hostile id", [row({ BulletinID: "1\r\nBEGIN:VEVENT" })]],
    ["float id", [row({ BulletinID: 1.5 })]],
    ["string flag", [row({ AllRoutesFlag: "true" })]],
    ["missing flag", [{ ...good, AllRoutesFlag: undefined }]],
    ["missing routes", [noRoutes]],
    ["string routes", [row({ AffectedRouteIDs: "6" })]],
    ["bad route id", [row({ AffectedRouteIDs: [6, "x"] })]],
    ["mixed good and bad", [good, row({ BulletinID: 2, AffectedRouteIDs: [272], AllRoutesFlag: "yes" })]],
    ["bad duplicate", [good, row({ AllRoutesFlag: null })]],
  ]) {
    assert.equal(validateAlerts(data), null, name);
  }
  assert.deepEqual(validateAlerts([]), []);
});

test("route parameter parsing", () => {
  assert.deepEqual(parseRoutes("5,3,6"), [5, 3, 6]);
  assert.deepEqual(parseRoutes(" 9 , 13 "), [9, 13]);
  assert.deepEqual(parseRoutes("1,2,3,4,5,6,7,8,9,10"), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  for (const bad of [undefined, "", ",", "12345", "0", "06", "1,2,3,4,5,6,7,8,9,10,11", "6;7", "6\r\n7",
    `${"1,".repeat(25)}1`]) {
    assert.equal(parseRoutes(bad), null, String(bad));
  }
});

// --- HTTP handler (fetch stubbed, console spied) ----------------------------------

const SECRET = "SENTINEL-c0de/+&=?";
const ENV = { WSF_API_ACCESS_CODE: SECRET, WSF_ROUTES: "5,3,6", WSF_INCLUDE_ALL_ROUTES: "true" };

async function call(path, upstream, env = ENV) {
  const realFetch = globalThis.fetch;
  const realConsole = { ...console };
  const logged = [];
  const requests = [];
  globalThis.fetch = async (url, init) => {
    requests.push({ url, init });
    if (upstream instanceof Error) throw upstream;
    return typeof upstream === "function" ? upstream() : upstream;
  };
  for (const level of ["log", "info", "warn", "error", "debug", "trace"]) {
    console[level] = (...args) => logged.push(args);
  }
  try {
    const res = await worker.fetch(new Request(`http://localhost${path}`), env);
    return { res, body: await res.text(), logged, requests };
  } finally {
    globalThis.fetch = realFetch;
    Object.assign(console, realConsole);
  }
}

const ok = () => Response.json(fixture);
const allRoutesFeed = () => Response.json([row({ BulletinID: 7, AllRoutesFlag: true, AffectedRouteIDs: [6] })]);

test("handler serves the default routes with the access code, JSON accept and edge cache", async () => {
  const { res, body, requests } = await call("/wsf.ics", ok);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("content-type"), "text/calendar; charset=utf-8");
  assert.equal(res.headers.get("cache-control"), "public, max-age=300");
  assert.deepEqual(uids(body), ["wsf-alert-113728@transit-ics"]); // 5,3,6: Kingston only
  assert.equal(requests.length, 1);
  assert.equal(
    requests[0].url,
    `https://www.wsdot.wa.gov/Ferries/API/Schedule/rest/alerts?apiaccesscode=${encodeURIComponent(SECRET)}`,
  );
  assert.deepEqual(requests[0].init, {
    headers: { accept: "application/json" },
    cf: { cacheTtl: 300, cacheEverything: true },
  });
});

test("handler honours ?routes= and the all-routes switch", async () => {
  assert.deepEqual(uids((await call("/wsf.ics?routes=9", ok)).body), ["wsf-alert-119049@transit-ics"]);
  const all = (path, env) => call(path, allRoutesFeed, env).then(({ body }) => events(body).length);
  const off = { ...ENV, WSF_INCLUDE_ALL_ROUTES: "false" };
  assert.equal(await all("/wsf.ics?routes=5"), 1); // default on
  assert.equal(await all("/wsf.ics?routes=6&allroutes=0"), 0); // off even though it lists route 6
  assert.equal(await all("/wsf.ics?routes=6", off), 0);
  assert.equal(await all("/wsf.ics?routes=6&allroutes=1", off), 1);
  assert.equal(await all("/wsf.ics", { ...ENV, WSF_INCLUDE_ALL_ROUTES: "yes" }), 1); // only "false" turns it off
});

test("empty ?routes= uses the default, as /transit.ics does", async () => {
  assert.deepEqual(uids((await call("/wsf.ics?routes=", ok)).body), ["wsf-alert-113728@transit-ics"]);
});

test("bad parameters are 400; missing configuration is 500; neither calls WSDOT", async () => {
  for (const [path, env, status, text] of [
    ["/wsf.ics?routes=12345", ENV, 400, "Invalid routes"],
    ["/wsf.ics?routes=6%0D%0AX", ENV, 400, "Invalid routes"],
    [`/wsf.ics?routes=${"1,".repeat(30)}`, ENV, 400, "Invalid routes"],
    ["/wsf.ics?allroutes=yes", ENV, 400, "Invalid allroutes"],
    ["/wsf.ics", { ...ENV, WSF_ROUTES: "5;3" }, 500, "WSF routes misconfigured"],
    ["/wsf.ics", { ...ENV, WSF_ROUTES: undefined }, 500, "WSF routes misconfigured"],
    ["/wsf.ics", { ...ENV, WSF_API_ACCESS_CODE: undefined }, 500, "WSF access code not configured"],
    ["/wsf.ics", { ...ENV, WSF_API_ACCESS_CODE: "" }, 500, "WSF access code not configured"],
  ]) {
    const { res, body, requests } = await call(path, ok, env);
    assert.equal(res.status, status, path);
    assert.equal(body, text);
    assert.equal(requests.length, 0);
  }
});

test("upstream failures are a fixed 502 that never echoes the code, URL or error", async () => {
  const echo = `apiaccesscode=${SECRET} ${encodeURIComponent(SECRET)}`;
  for (const [name, upstream] of [
    ["503", () => new Response(echo, { status: 503, statusText: echo })],
    ["thrown fetch", new TypeError(`fetch failed for https://x/?apiaccesscode=${SECRET}`)],
    ["invalid JSON", () => new Response(`not json ${echo}`)],
    ["XML", () => new Response(`<ArrayOfAlertResponse>${echo}</ArrayOfAlertResponse>`)],
    ["error object", () => Response.json({ Message: echo })],
    ["error row", () => Response.json([{ Message: echo }])],
    ["mixed rows", () => Response.json([...fixture, row({ AffectedRouteIDs: "6" })])],
    ["renamed routes field", () => Response.json(fixture.map(({ AffectedRouteIDs, ...r }) => ({ ...r, RouteIDs: AffectedRouteIDs })))],
  ]) {
    const { res, body, logged } = await call("/wsf.ics", upstream);
    assert.equal(res.status, 502, name);
    assert.equal(body, "Upstream feed error", name);
    assert.deepEqual(logged, [], `${name}: nothing logged`);
  }
});

test("a valid empty list is a real empty calendar, not an error", async () => {
  const { res, body } = await call("/wsf.ics", () => Response.json([]));
  assert.equal(res.status, 200);
  assert.equal(events(body).length, 0);
});

test("Worker-generated responses and logs never contain the access code", async () => {
  for (const path of ["/wsf.ics", "/wsf.ics?routes=x", "/wsf.ics?allroutes=2", "/nope"]) {
    for (const upstream of [ok, () => new Response("x", { status: 500 }), new Error(SECRET)]) {
      const { body, logged, res } = await call(path, upstream);
      for (const text of [body, JSON.stringify(logged), JSON.stringify([...res.headers])]) {
        assert.ok(!text.includes(SECRET) && !text.includes(encodeURIComponent(SECRET)), path);
      }
    }
  }
});
