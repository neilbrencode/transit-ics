# 2. Host on a Cloudflare Worker (free plan)

- Status: Accepted
- Date: 2026-10-08

## Context

Outlook.com subscribes to calendars by URL and re-fetches every few hours on its own schedule. Something must serve an `.ics` file at a stable public URL. The owner is sensitive to cost and to GitHub Actions (GHA) minutes, and the owner's laptop is not always on.

## Decision

Serve `/transit.ics` from a Cloudflare Worker on the Workers Free plan, using a generic `workers.dev` subdomain.

```mermaid
flowchart LR
  O[Outlook.com] -- "GET /transit.ics" --> W[Cloudflare Worker]
  W -- "fetch, edge-cached 5 min" --> ST[(ST alerts feed)]
```

## Alternatives considered

- **GitHub Action on a cron, publishing a static `.ics` to GitHub Pages.** Spends GHA minutes if the repo is private. In a public repo, GitHub disables scheduled workflows after 60 days without repo activity, so the calendar would silently go stale. Data is only as fresh as the last run.
- **Local scheduled task syncing events into Outlook via a local Model Context Protocol (MCP) server.** Only runs while the laptop is on, and only works for the owner's own calendar, not for family subscribers.

## Consequences

- $0: the free plan allows 100,000 requests/day and 10 ms CPU per request; we expect a handful of requests a day at about 1 ms each.
- Zero GHA minutes at runtime. CI runs only on push and pull request.
- Data is as fresh as the request (plus a 5-minute edge cache), so freshness is limited by Outlook's refresh cadence, not by us.
- Adds a Cloudflare account and the `wrangler` command-line tool (installed locally, not globally) to the toolchain.
- The URL is public by obscurity only. That is acceptable because the data is public.
