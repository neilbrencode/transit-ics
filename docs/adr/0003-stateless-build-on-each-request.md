# 3. Stateless: build the calendar on each request

- Status: Accepted
- Date: 2026-10-08

## Context

Alerts appear, change and get cleared. The calendar must reflect cleared alerts by removing them, without us tracking what was previously published.

## Decision

The Worker keeps no state. On every request it fetches the feed, filters it, and renders iCalendar from scratch. Each event gets a stable UID, `st-alert-<alertId>-<periodIndex>@transit-ics`, so calendar clients update events in place and drop any UID that no longer appears.

## Alternatives considered

- **Store published alerts in Workers KV or D1** (Cloudflare's key-value store and SQL database) and diff against the feed. This would allow features like "recently cleared" history. It adds storage, bindings, consistency questions and a write path, none of which the core goal needs.

## Consequences

- Removal of cleared alerts is automatic and needs no code.
- Nothing to migrate, back up or corrupt. The Worker is a pure function of the feed, which also makes it easy to test with a saved fixture.
- No history: once ST clears an alert, it is gone from the calendar.
- UID stability depends on ST keeping alert ids and period order stable. If ST reorders `active_period`, an event may briefly duplicate until the next refresh.
- Open-ended alerts can be rendered relative to "now" (through today) because each request re-renders them.
