# 7. The WSDOT access code is a Worker secret, kept out of the repo and logs

- Status: Accepted
- Date: 2026-10-12

## Context

The WSDOT Ferries API expects an access code, `?apiaccesscode=`, registered to an email address. Anyone holding it can use the API under that registration, so a leak invites abuse in the owner's name. It travels in the upstream URL's query string, which is exactly what error messages, logs and stack traces tend to copy.

On 2026-10-12 the alerts operation answered without a code too. We send it anyway: WSDOT's terms ask for it, and enforcement could start at any time.

[ADR 1](0001-source-st-gtfs-rt-alerts-feed.md) recorded "no secrets anywhere in the project". This ADR amends that consequence; the Sound Transit feed itself still needs none.

## Decision

| Where it could leak | Control |
|---|---|
| Cloudflare | Stored with `npx wrangler secret put WSF_API_ACCESS_CODE` (encrypted; not shown again). Never in `wrangler.toml` `[vars]`, which is plain text. |
| Git | Kept **outside the working tree**, in `%USERPROFILE%\.secrets\transit-ics.dev.vars`, and loaded by `npm run dev` (`scripts/dev.mjs`, which passes `--env-file`). `.env` and `.dev.vars` are gitignored as a backstop. `test/no-leaks.test.js` reads the outside file on purpose and fails if the value appears in any file git could commit, reporting file:line only. |
| AI review tools | Reviewer CLIs run in the working tree, and the code isn't there. This lowers exposure but isn't a hard boundary: any process running as the owner can read the outside file. |
| Responses | Errors are fixed strings (`Upstream feed error`). No URL, status text, upstream body or exception text is ever returned. |
| Logs | The WSF path calls no `console.*`, and the fetch is wrapped so no uncaught exception carries the URL into a stack trace. Workers Logs is pinned off (`[observability] enabled = false`). |
| Local dev state | Plain `wrangler dev` records each upstream URL, code included, in a local trace database under `.wrangler/` (found 2026-10-12). `scripts/dev.mjs` sets `X_LOCAL_OBSERVABILITY=false` and `--persist-to` a temp directory outside the repo. That variable is a wrangler internal and could change; re-check after wrangler upgrades by grepping `.wrangler/` and the temp directory for the code. |
| CI | Needs no code: tests stub `fetch`. No GitHub secret exists. |
| Abuse through the Worker | The upstream URL is fixed (route filtering is local), so query strings can't fragment the 5-minute edge cache. That keeps upstream traffic low; it is not a rate limiter. |

Tests assert that the fetched URL carries the code, and that no Worker-generated response or log contains it. Alert text is WSDOT's content and passes through as-is.

## Alternatives considered

- **Send no code, since the endpoint doesn't enforce it today.** No leak risk, but against WSDOT's terms, and the feed would return 502 the day enforcement starts.
- **`.dev.vars` in the repo, gitignored.** The usual wrangler pattern, but every tool working in the repo can read it, and an ignore rule is one `git add -f` from failing.
- **A GitHub secret for CI.** Not needed; tests are offline.

## Consequences

- One secret to manage. If it leaks: register again for a new code, `wrangler secret put` it, and ask WSDOT to revoke the old one. See the [runbook](../runbook-cloudflare.md#if-the-wsdot-access-code-leaks).
- A missing secret is a 500 (`WSF access code not configured`), so a deploy without it fails loudly rather than serving an empty calendar.
- The leak test can't see git history, commit messages, PRs or issues.
