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

test("empty feed still yields a valid calendar", () => {
  const evs = events(buildCalendar({ header: { timestamp: NOW }, entity: [] }, ["2LINE"], NOW));
  assert.equal(evs.length, 0);
});

// --- HTTP handler (fetch mocked) ------------------------------------------
import worker from "../src/index.js";

async function call(path, upstream) {
  const real = globalThis.fetch;
  globalThis.fetch = async () => upstream;
  try { return await worker.fetch(new Request(`https://x.workers.dev${path}`)); }
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

test("upstream failure returns 502, never an empty calendar", async () => {
  const res = await call("/transit.ics", new Response("nope", { status: 503 }));
  assert.equal(res.status, 502);
});

test("other paths 404", async () => {
  const res = await call("/", Response.json(feed));
  assert.equal(res.status, 404);
});
