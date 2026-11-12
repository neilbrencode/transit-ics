# 9. Pin the Cloudflare account from outside the repo

- Status: Accepted
- Date: 2026-11-11

## Context

Wrangler's OAuth login is global: every project on the machine uses whichever account was signed in last. On 2026-11-11 `npx wrangler deploy` ran while signed in to an account used for another project. Nothing failed. Wrangler created a new `transit-ics` Worker there, with no `WSF_API_ACCESS_CODE` secret (so its `/wsf.ics` returned 500), and the real Worker wasn't updated. The stray Worker was deleted and the deploy redone.

The usual fix, `account_id` in `wrangler.toml`, would put the account ID in git. The owner doesn't want that ([issue #14](https://github.com/neilbrencode/transit-ics/issues/14)).

Wrangler 4.149 picks the account in this order (`getActiveAccountId`): an active temporary account (`--temporary`, unauthenticated only), then `account_id` in the selected config file, then `CLOUDFLARE_ACCOUNT_ID`, then its cached account. Measured: with `CLOUDFLARE_ACCOUNT_ID` set to an account the login can't reach, `wrangler deployments list` fails with `Authentication error [code: 10000]` and changes nothing.

## Decision

Every wrangler command that talks to Cloudflare runs through `scripts/wrangler.mjs` (`npm run deploy`, `npm run secret:put`, `npm run wrangler -- <command>`). It:

1. Reads the expected account from `%USERPROFILE%\.secrets\transit-ics.deploy.vars` (`CLOUDFLARE_ACCOUNT_ID=<id>`, last assignment wins). That's a separate file from the access code's, because `transit-ics.dev.vars` goes to `wrangler dev --env-file` and would expose anything in it to the local Worker. If the file is missing or the ID is malformed, it refuses.
2. Rules out what outranks or redirects the pin:
   - It always passes `--config <repo>/wrangler.toml`. With an explicit config, wrangler doesn't look for `wrangler.json`, `wrangler.jsonc` or redirect configs elsewhere.
   - It refuses `--config`, `--cwd`, `--env`, `--env-file`, `--temporary`, `--event-code` and `--profile`, in every spelling yargs accepts.
   - It refuses a `wrangler.toml` that mentions `account_id` at all, or contains a `\u` escape, which could spell it. That fails closed without parsing TOML.
   - It refuses a `.env` or `.env.local` in the repo. Wrangler loads those into its environment, where they could select a named environment.
   - It removes `CLOUDFLARE_ENV` and `WRANGLER_LOG` from wrangler's environment, and refuses an inherited `CLOUDFLARE_ACCOUNT_ID` that differs from the file.
   - It accepts only the commands this project uses: deploy, rollback, deployments list, versions list and view, secret list, put and delete, delete, tail and whoami.
3. Runs `wrangler whoami --json` with output captured, and refuses unless the login can reach the expected account.
4. Runs the command with `CLOUDFLARE_ACCOUNT_ID` set and `WRANGLER_LOG_SANITIZE=true`, on the terminal, so prompts work. It exits with wrangler's status.

The script's own messages never name an account. Wrangler's output passes through unchanged. It already shows account IDs (the `whoami` table, `/accounts/<id>/…` in API errors), and capturing it would break prompts such as the rollback confirmation. CI never deploys, so that output reaches only the local terminal. `test/no-leaks.test.js` also scans for the saved ID, in either case, in every file git could commit.

## Alternatives considered

- **`account_id` in `wrangler.toml`.** It's the simplest and wrangler's own answer, but it puts the ID in git.
- **Check `wrangler whoami` only.** It's advisory: a login that reaches several accounts can still pick the wrong one, and the command that runs isn't pinned.
- **A per-repo API token in `CLOUDFLARE_API_TOKEN`.** That avoids the shared login, but it's more setup and another secret to rotate. It's still open if switching logins gets tiresome.
- **Redact wrangler's output.** That needs a pseudo-terminal to keep prompts working. It's more machinery than the risk warrants, since the output stays local.

## Consequences

- Typing `npx wrangler deploy` directly still bypasses the check. The runbook keeps plain `npx wrangler` for `login`, `logout` and `whoami` only.
- A new wrangler flag or environment variable that selects config or account could reopen a gap. Recheck the list in `scripts/wrangler.mjs` when upgrading wrangler across a major version.
- Each command makes one extra API call (`whoami`).
