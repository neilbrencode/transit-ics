# Architecture Decision Records

Each Architecture Decision Record (ADR) captures one decision, why it was made, and what was rejected, so it doesn't get relitigated. To change a decision, add a new ADR that supersedes the old one, and set the old one's status to `Superseded by N`.

| # | Decision | Status |
|---|---|---|
| 1 | [Use Sound Transit's public GTFS-RT alerts feed](0001-source-st-gtfs-rt-alerts-feed.md) | Accepted |
| 2 | [Host on a Cloudflare Worker (free plan)](0002-host-on-cloudflare-worker.md) | Accepted |
| 3 | [Stateless: build the calendar on each request](0003-stateless-build-on-each-request.md) | Accepted |
| 4 | [Upstream failure returns 502, never an empty calendar](0004-upstream-failure-returns-502.md) | Accepted |

Decisions 5–10 in the original handoff (event shapes, service-day rollover, `TRANSP`, default route, local dev dependencies) are documented in the [README](../../README.md) and code comments. Promote any of them to an ADR if they come up for debate.
