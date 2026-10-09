# transit-ics

Sound Transit service alerts as a calendar you subscribe to in Outlook.

A single Cloudflare Worker (no dependencies, no storage, no schedule). Each time
your calendar app asks for `/transit.ics`, the Worker reads Sound Transit's
public GTFS-Realtime alerts feed, keeps the routes you asked for, and returns
iCalendar. Alerts that Sound Transit clears disappear on the next refresh.

```mermaid
flowchart LR
  O[Outlook.com<br/>subscribed calendar] -- "GET /transit.ics (every few hours)" --> W[Cloudflare Worker]
  W -- "fetch, edge-cached 5 min" --> ST[(Sound Transit<br/>alerts_pb.json on S3)]
```

## How alerts become events

| Alert shape | Calendar event |
|---|---|
| Up to 24 hours (e.g. a concert, 8:00–11:30 p.m.) | Timed event |
| Longer than 24 hours (e.g. a weekend closure) | All-day banner across those dates |
| No end time ("until further notice") | All-day banner from start through today, prefixed `[Ongoing]` |

- Ends before 4 a.m. count as the previous service day, so "until end of service Sunday" (about 2:30 a.m. Monday in the feed) doesn't spill onto Monday.
- Events are marked **Free**, not Busy.
- The description holds the full alert text and the Sound Transit link.

## Routes

`/transit.ics` defaults to the 2 Line. Add `?routes=` for others (comma-separated):

| Line | route id |
|---|---|
| 2 Line | `2LINE` |
| 1 Line | `100479` |
| Sounder N/S | `SNDR_EV`, `SNDR_TL` (check feed) |

Example: `https://transit-ics.<subdomain>.workers.dev/transit.ics?routes=2LINE,100479`

Route ids may contain only letters, digits and `_`; anything else returns 400.

## Cost

$0 on the Workers Free plan. That plan allows 100,000 requests a day and
10 ms CPU per request. This feed gets a few requests a day and uses about 1 ms
each. It uses no GitHub Actions minutes.

## Deploy (PowerShell)

Live at <https://transit-ics.pnw-st.workers.dev/transit.ics>. For the full
setup, update, rollback and troubleshooting steps, see the
[Cloudflare runbook](docs/runbook-cloudflare.md). Quick version:

`wrangler dev` runs the Worker locally in `workerd`, Cloudflare's runtime. It
works on Windows x64. `workerd` has no Windows-ARM64 build, so on an ARM64
laptop use WSL (Ubuntu) for `wrangler dev`, or skip it. `wrangler deploy` only
uploads code and does not need `workerd`.

```powershell
cd transit-ics
npm install            # local only; nothing installed globally
npm test               # offline, uses the saved fixture
npx wrangler dev       # optional: http://localhost:8787/transit.ics against the live feed
npx wrangler login     # opens browser, one-time
npx wrangler deploy    # prints https://transit-ics.<subdomain>.workers.dev
```

Then open `https://transit-ics.<subdomain>.workers.dev/transit.ics` in a browser.
It should download a small `.ics` file.

**No-tooling fallback:** in the Cloudflare dashboard, go to Workers & Pages,
then Create, then Hello World. Choose **Edit code**, paste in `src/index.js`,
and click Deploy.

## Subscribe in Outlook.com

1. Go to Outlook.com, then Calendar, then **Add calendar**, then **Subscribe from web**.
2. Paste the `/transit.ics` URL.
3. Name it **Transit**, pick a color, and click Import.

The new calendar also appears in the Outlook apps on Windows and Android.
Family members can subscribe to the same URL.

Outlook.com decides how often to re-fetch, typically every few hours. The
feed's `REFRESH-INTERVAL` hint of 1 hour is advisory. For same-hour
disruptions, keep the email/SMS alerts.

## Source data

- Feed: <https://s3.amazonaws.com/st-service-alerts-prod/alerts_pb.json> (GTFS-RT Alerts, JSON form, no key)
- Terms: [Sound Transit Open Transit Data](https://www.soundtransit.org/help-contacts/business-information/open-transit-data-otd/otd-downloads)
- `test/fixture-2026-10-08.json` is a trimmed real snapshot used by the tests.
