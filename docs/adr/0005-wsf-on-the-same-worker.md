# 5. Serve Washington State Ferries alerts from the same Worker

- Status: Accepted
- Date: 2026-10-12

## Context

We want Washington State Ferries (WSF) service alerts on a subscribed calendar too: cancellations, delays, reduced service and terminal notices. The Sound Transit feed already has the iCalendar helpers (escaping, folding, UID encoding, Pacific dates), deploy, tests, CI and a private `workers.dev` hostname.

WSF alerts come from the WSDOT Ferries Schedule API alerts operation, `https://www.wsdot.wa.gov/Ferries/API/Schedule/rest/alerts`. It returns JSON with `Accept: application/json` (XML otherwise) and expects an access code. The other candidate, OneBusAway's GTFS-RT protobuf for WSF, would need a protobuf parser this Worker doesn't have, plus its own key.

## Decision

Add `/wsf.ics` to the existing Worker, next to `/transit.ics`. The code is split into modules: `src/ical.js` (shared helpers), `src/st.js` (Sound Transit) and `src/wsf.js` (WSF), with `src/index.js` routing.

Routes are configuration, not code:

- `?routes=5,3` on the URL, as `/transit.ics` does. Ids are WSDOT's numeric route ids from the API's routes operation: 1–4 digits, at most 10.
- Without `?routes=`, `WSF_ROUTES` in `wrangler.toml` `[vars]` (`5,3,6`: Seattle/Bainbridge, Seattle/Bremerton, Edmonds/Kingston).
- An alert WSF flags `AllRoutesFlag` is included exactly when all-routes notices are on, whatever routes it also lists. Any other alert is included when its `AffectedRouteIDs` intersect the requested routes. All-routes notices are on by default (`WSF_INCLUDE_ALL_ROUTES`); `?allroutes=0` or `?allroutes=1` overrides that per subscription.

The response is validated as a whole before any filtering. Anything structurally wrong (not an array, a row without a positive integer `BulletinID`, a non-boolean `AllRoutesFlag`, a missing or malformed `AffectedRouteIDs`) returns 502, per [ADR 4](0004-upstream-failure-returns-502.md), so a WSDOT schema change can't become a valid but empty calendar.

## Alternatives considered

- **A separate Worker or repo.** Would copy about 80 lines of helpers and duplicate deploy, CI and hostname handling, for no isolation benefit worth having at this size.
- **OneBusAway GTFS-RT for WSF.** Needs protobuf parsing and another key.
- **Hard-coded routes.** Changing them would need a code change and deploy.

## Consequences

- One deploy, one hostname, one request quota for both feeds.
- The project's first secret, the WSDOT access code; see [ADR 7](0007-wsdot-access-code-secret.md).
- The Cloudflare dashboard "paste one file" fallback no longer works, because the Worker is several modules. Deploy with `wrangler`.
- WSF lists extra internal route ids in `AffectedRouteIDs` (for example `272` on a San Juans alert) that the routes operation doesn't return. They are accepted, but only match if requested.
