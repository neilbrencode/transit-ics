# 6. WSF alerts are all-day banners from publish date through today

- Status: Accepted
- Date: 2026-10-12

## Context

The WSDOT alerts operation has no start or end time. A spike against the live API on 2026-10-12 found only `PublishDate`, in .NET JSON form: `"/Date(1791825236330-0700)/"`. The number is UTC epoch milliseconds; the offset is for display only, so no Pacific or DST conversion is needed to get the instant. End dates appear only in prose ("through Oct.12").

The two live alerts that day showed the problem:

| Alert | Published | Still listed |
|---|---|---|
| Kingston boarding pass required daily | Aug 30 | Oct 12 |
| Yakima elevator back in service | Oct 12 | Oct 12 |

## Decision

Each alert is an all-day event, summary prefixed `⛴ [Ongoing]`:

- `DTSTART` is the Pacific date it was published.
- `DTEND` (exclusive) is the day after today, Pacific, so the banner always covers today. There is no 4 a.m. service-day rollover: that is a Sound Transit rule for end times after midnight, and WSF has no end times.
- A future publish date (clock skew) is a single-day event on that date.
- An unparseable date, or one whose start or exclusive end falls outside 2000–2099, is a one-day banner on today. The range keeps every emitted date a valid four-digit iCalendar year.

The banner extends by a day each day while WSF lists the alert, and disappears when WSF removes it ([ADR 3](0003-stateless-build-on-each-request.md)). Because `DTEND` is regenerated daily, `DTSTAMP` is the render time and there is no `LAST-MODIFIED`.

## Alternatives considered

- **All-day on the publish date only.** The Kingston notice would sit on Aug 30 and be invisible while still in force.
- **A short timed event at publish time.** Same problem, and a 10:13 a.m. block implies a time the disruption doesn't have.
- **Parse dates from the text.** Fragile; WSF writes dates many ways.

## Consequences

- Long-lived notices make long banners. If that proves noisy, cap the start (for example at today minus 7 days).
- Outlook must accept a changing `DTEND` under a stable UID. The next-day check after deploy confirms it (see the runbook).
- A bulletin WSF republishes under a new `BulletinID` (an "Update") is a new event; the old one stays until WSF removes it.
