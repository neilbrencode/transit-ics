// Run: npm test   (node --test, no framework)
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import ICAL from "ical.js";
import { buildCalendar } from "../src/index.js";

const feed = JSON.parse(readFileSync(new URL("./fixture-2026-10-08.json", import.meta.url)));
const NOW = 1791504386; // 2026-10-08 ~17:06 PT, same as the snapshot

function events(ics) {
  const comp = new ICAL.Component(ICAL.parse(ics)); // throws on malformed ICS
  return comp.getAllSubcomponents("vevent").map((v) => new ICAL.Event(v));
}
const byId = (evs, id) => evs.find((e) => e.uid.startsWith(`st-alert-${id}-`));

test("2 Line filter returns exactly the 4 alerts the website shows", () => {
  const evs = events(buildCalendar(feed, ["2LINE"], NOW));
  assert.deepEqual(
    evs.map((e) => e.uid.split("-")[2]).sort(),
    ["20937", "20993", "21008", "21216"],
  );
});

test("adding the 1 Line picks up 1-Line-only alerts, not Sounder", () => {
  const evs = events(buildCalendar(feed, ["2LINE", "100479"], NOW));
  assert.equal(evs.length, 5);
  assert.ok(!byId(evs, "16623"), "Sounder alert should be excluded");
});

test("short alert (concert) is a timed event at the right local time", () => {
  const e = byId(events(buildCalendar(feed, ["2LINE"], NOW)), "20937");
  assert.equal(e.startDate.isDate, false);
  assert.equal(e.startDate.toUnixTime(), 1791514800); // 8:00 p.m. PT Oct 8
  assert.equal(e.endDate.toUnixTime(), 1791527400);   // 11:30 p.m. PT
});

test("multi-day closure is an all-day banner covering Oct 17-18 PT", () => {
  const e = byId(events(buildCalendar(feed, ["2LINE"], NOW)), "21008");
  assert.equal(e.startDate.isDate, true);
  assert.equal(e.startDate.toString(), "2026-10-17");
  // Feed end is ~2:30 a.m. Oct 19 ("end of service Sunday"); must not spill onto Monday.
  assert.equal(e.endDate.toString(), "2026-10-19"); // exclusive => last day shown is Oct 18
});

test("nightly-closure alert 'Oct 6 thru Oct 9' ends on Oct 9, not Oct 10", () => {
  const e = byId(events(buildCalendar(feed, ["2LINE"], NOW)), "20993");
  assert.equal(e.startDate.toString(), "2026-10-06");
  assert.equal(e.endDate.toString(), "2026-10-10"); // exclusive => last day shown is Oct 9
});

test("Mercer Island sidewalk work spans Oct 8-31", () => {
  const e = byId(events(buildCalendar(feed, ["2LINE"], NOW)), "21216");
  assert.equal(e.startDate.toString(), "2026-10-08");
  assert.equal(e.endDate.toString(), "2026-11-01");
});

test("open-ended alert becomes an [Ongoing] all-day banner through today", () => {
  const e = byId(events(buildCalendar(feed, ["100479"], NOW)), "21145");
  assert.equal(e.startDate.isDate, true);
  assert.match(e.summary, /^\[Ongoing\] Federal Way/);
  assert.equal(e.endDate.toString(), "2026-10-09"); // exclusive => shows through Oct 8
});

test("URLs are trimmed and text survives escaping round-trip", () => {
  const e = byId(events(buildCalendar(feed, ["2LINE"], NOW)), "21008");
  assert.equal(
    e.component.getFirstPropertyValue("url"),
    "https://www.soundtransit.org/ride-with-us/changes-affect-my-ride/planned-service-disruptions",
  );
  assert.match(e.description, /trains; Link shuttle buses will run approximately every 10 to 15 minutes, between/);
  assert.match(e.summary, /Int'l District\/Chinatown/);
});

test("every physical line is <= 75 octets and uses CRLF (RFC 5545)", () => {
  const ics = buildCalendar(feed, ["2LINE", "100479"], NOW);
  assert.ok(!/[^\r]\n/.test(ics), "bare LF found");
  for (const line of ics.split("\r\n")) {
    assert.ok(Buffer.byteLength(line) <= 75, `too long: ${line}`);
  }
});

test("non-ASCII text (en dash, curly quote) folds without splitting characters", () => {
  const ics = buildCalendar(feed, ["100479", "2LINE", "SNDR_TL"], NOW);
  const evs = events(ics);
  assert.match(byId(evs, "16623").summary, /Kent Station’s northwest/);
  assert.match(byId(evs, "20993").description, /every 10–15 minutes/);
});

// A one-hour 2 Line alert, for synthetic feeds
const entity = (id, alert = {}) => ({
  id,
  alert: {
    informed_entity: [{ route_id: "2LINE" }],
    active_period: [{ start: NOW, end: NOW + 3600 }],
    ...alert,
  },
});
const uidsOf = (...entities) =>
  events(buildCalendar({ entity: entities }, ["2LINE"], NOW)).map((e) => e.uid);
const en = (text) => ({ translation: [{ language: "en", text }] });

test("line breaks in feed id or url cannot inject iCalendar lines", () => {
  const evil = { entity: [entity("1\r\nBEGIN:VEVENT", { url: en("https://x\nSUMMARY:pwned") })] };
  const ics = buildCalendar(evil, ["2LINE"], NOW);
  assert.equal(events(ics).length, 1);
  assert.equal((ics.match(/^BEGIN:VEVENT/gm) ?? []).length, 1);
  assert.ok(!/^SUMMARY:pwned/m.test(ics));
});

test("ids differing only by line breaks still get distinct UIDs", () => {
  const uids = uidsOf(entity("alert1"), entity("alert\r\n1"));
  assert.equal(new Set(uids).size, 2);
  assert.ok(uids.includes("st-alert-alert1-0@transit-ics"), "plain ids must be unchanged");
});

test("UIDs for the captured fixture snapshot are exactly st-alert-<id>-<period>", () => {
  const routes = [...new Set(feed.entity.flatMap((e) => e.alert.informed_entity.map((i) => i.route_id)))];
  const uids = events(buildCalendar(feed, routes, NOW)).map((e) => e.uid).sort();
  const expected = feed.entity
    .flatMap((e) => (e.alert.active_period?.length ? e.alert.active_period : [{}])
      .map((_, i) => `st-alert-${e.id}-${i}@transit-ics`))
    .sort();
  assert.ok(expected.length > 0);
  assert.deepEqual(uids, expected);
});

test("malformed Unicode in an id (lone surrogate) still renders the calendar", () => {
  assert.equal(uidsOf(entity("\uD800")).length, 1);
});

test("UID encoding is injective: surrogates and literal escapes stay distinct", () => {
  assert.equal(new Set(uidsOf(entity("\uD800"), entity("\uDBFF"))).size, 2);
  assert.equal(new Set(uidsOf(entity("a%b"), entity("a%0025b"))).size, 2);
});

// Unfolded text must round-trip exactly, with every physical line <= 75 octets
function assertFoldsCleanly(description) {
  const ics = buildCalendar({ entity: [entity("1", { description_text: en(description) })] }, ["2LINE"], NOW);
  for (const line of ics.split("\r\n")) {
    assert.ok(Buffer.byteLength(line) <= 75, `too long: ${line}`);
  }
  assert.equal(events(ics)[0].description, description);
}

test("multi-byte characters fold correctly at every offset on first and continuation lines", () => {
  for (const ch of ["–", "😀"]) { // 3 and 4 UTF-8 bytes
    for (let k = 0; k <= 160; k++) assertFoldsCleanly("a".repeat(k) + ch + "b".repeat(80));
  }
});

test("empty feed still yields a valid calendar", () => {
  const evs = events(buildCalendar({ header: { timestamp: NOW }, entity: [] }, ["2LINE"], NOW));
  assert.equal(evs.length, 0);
});

// --- HTTP handler (fetch mocked) ------------------------------------------
import worker from "../src/index.js";

async function call(path, upstream) {
  const real = globalThis.fetch;
  globalThis.fetch = async () => upstream;
  try { return await worker.fetch(new Request(`http://localhost${path}`)); }
  finally { globalThis.fetch = real; }
}

test("handler serves text/calendar for /transit.ics", async () => {
  const res = await call("/transit.ics", Response.json(feed));
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type"), /^text\/calendar/);
  assert.equal(events(await res.text()).length, 4);
});

test("handler honours ?routes=", async () => {
  const res = await call("/transit.ics?routes=2LINE,100479", Response.json(feed));
  assert.equal(events(await res.text()).length, 5);
});

test("route ids with line breaks or punctuation are rejected with 400", async () => {
  for (const q of ["2LINE%0D%0ABEGIN:VEVENT", "2LINE;X", ","]) {
    const res = await call(`/transit.ics?routes=${q}`, Response.json(feed));
    assert.equal(res.status, 400, q);
  }
});

test("route ids are limited to 32 characters and 10 per request", async () => {
  const id32 = "R".repeat(32);
  const ten = [id32, ...Array.from({ length: 9 }, (_, i) => `ROUTE${i}`)].join(",");
  for (const [q, status] of [
    [id32, 200],
    [ten, 200],
    ["R".repeat(33), 400],
    [`${ten},EXTRA`, 400],
    ["A,".repeat(1000), 400], // oversized value
  ]) {
    const res = await call(`/transit.ics?routes=${q}`, Response.json(feed));
    assert.equal(res.status, status, q.slice(0, 40));
  }
});

test("upstream failure returns 502, never an empty calendar", async () => {
  const res = await call("/transit.ics", new Response("nope", { status: 503 }));
  assert.equal(res.status, 502);
});

test("other paths 404", async () => {
  const res = await call("/", Response.json(feed));
  assert.equal(res.status, 404);
});
