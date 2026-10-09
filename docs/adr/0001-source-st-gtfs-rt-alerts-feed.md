# 1. Use Sound Transit's public GTFS-RT alerts feed as the data source

- Status: Accepted
- Date: 2026-10-08

## Context

We want Sound Transit (ST) service alerts for the 2 Line (optionally the 1 Line) on a subscribed calendar. The source must give machine-readable start and end times and route identifiers, be reliable enough to poll, and not require secrets.

## Decision

Read ST's public General Transit Feed Specification Realtime (GTFS-RT) Alerts feed in its JSON form:
<https://s3.amazonaws.com/st-service-alerts-prod/alerts_pb.json>.
Filter alerts by `informed_entity[].route_id` (`2LINE`, `100479` for the 1 Line).

The protobuf form at `.../alerts.pb` carries the same data. We use JSON because a Worker can parse it with no dependencies.

## Alternatives considered

- **Scrape soundtransit.org.** Alerts are server-rendered HTML with no structured times. Any page redesign breaks it.
- **OneBusAway GTFS-RT.** Equivalent data, but needs an API key, which adds a secret to manage.

## Consequences

- No API key and no secrets anywhere in the project.
- Start and end times are Unix epochs and route ids are explicit, so filtering and calendar mapping are exact.
- We depend on an undocumented-but-public S3 URL. If ST moves it, the Worker returns 502 (see [ADR 4](0004-upstream-failure-returns-502.md)) and the URL needs updating.
- Real-data quirks (trailing spaces, `\r\n\n` line endings, missing `end`, non-ASCII text) must be handled in code. `test/fixture-2026-10-08.json` pins them.
- Use is governed by ST's [Open Transit Data terms](https://www.soundtransit.org/help-contacts/business-information/open-transit-data-otd/otd-downloads).
