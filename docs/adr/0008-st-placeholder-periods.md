# 8. Placeholder ST periods take their dates from the alert text

- Status: Accepted
- Date: 2026-11-11

## Context

Sound Transit (ST) alert 21608, a weekend 2 Line closure, arrived on 2026-11-11 with one active period of 3:00–3:05 a.m. Pacific on Saturday Nov 14. The real dates were only in the headline: "from start of service Saturday, Nov. 14 until end of service Sunday, Nov. 15". The up-to-24-hours rule made it a 5-minute timed event at 3 a.m., so it was easy to miss in Outlook.

3:00 a.m. is the start time ST gives its other planned closures, and Link doesn't run between about 1 and 5 a.m. A real disruption that short, at that hour, affects no riders.

## Decision

A period is a **placeholder** when it has both a start and an end, lasts under 15 minutes, and starts between 1:00 and 5:00 a.m. Pacific. Any other period is rendered as before.

A placeholder becomes an all-day event:

- Across the first date range in the headline, or failing that the description, such as `[start of service] [Saturday,] Nov. 14[, 2026][,] until|through|thru|to [end of service] [on] [Sunday,] Nov. 15`. `DTEND` is the day after the end date. There is no 4 a.m. rollover, because these are already service-day dates.
- A missing year is whichever of last, this or next year puts the start within 7 days of the period's date. The end year follows the start, plus one when the end falls before the start (December to January). The range must be unambiguous, made of real dates, end on or after its start, and span at most 31 days (end date minus start date). Otherwise it is ignored.
- With no usable range, the event covers the period's own date.

UIDs don't change, so Outlook replaces the existing timed event in place.

## Alternatives considered

- **All-day on the period's date only.** Robust, but this closure would show on Saturday and not Sunday.
- **Parse the text for every alert.** The feed's periods are right for every other alert seen so far. Text is a fallback for data that is plainly a placeholder, not a second source to reconcile.
- **Do nothing and report it to ST.** The calendar stays wrong until ST changes its tooling.

## Consequences

- The parser follows ST's current wording. If ST words a closure differently, the alert still shows as an all-day event on its first day, just not across the full range.
- If ST starts giving real periods to these alerts, they are no longer placeholders and the feed's times apply again.
