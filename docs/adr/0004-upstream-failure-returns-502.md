# 4. Upstream failure returns 502, never an empty calendar

- Status: Accepted
- Date: 2026-10-08

## Context

Calendar clients treat a subscribed feed as the full truth. If a refresh returns a valid calendar with no events, Outlook deletes every existing event. The upstream feed on S3 can fail, time out or return an error.

## Decision

If the upstream fetch is not OK, the Worker responds **502 Bad Gateway** with a short plain-text message. It never returns an empty or partial `.ics` in place of real data.

An empty calendar is still returned when the feed itself succeeds and simply has no matching alerts. That is a true "no alerts" state.

## Alternatives considered

- **Serve an empty `.ics`.** Wipes every event from subscribers' calendars during a transient outage.
- **Serve the last good (stale) `.ics`.** Needs storage, which contradicts [ADR 3](0003-stateless-build-on-each-request.md). Calendar clients already keep their last good copy when a refresh fails, so we get stale-on-error behaviour for free.

## Consequences

- Transient upstream outages are invisible to subscribers: Outlook keeps showing the previous events.
- A long outage means events go stale rather than disappearing, which is the safer failure.
- Malformed JSON from upstream currently throws, which Cloudflare surfaces as an error response (not a 200), so it fails safe in the same way.
- Tested by `upstream failure returns 502, never an empty calendar`.
