// npm run dev: wrangler dev with the WSDOT access code kept out of the repo (ADR 7)
//
// - Loads the code from outside the working tree (--env-file).
// - Turns off wrangler's local request tracing (X_LOCAL_OBSERVABILITY), which
//   otherwise records each upstream URL, access code included, in a SQLite
//   file under .wrangler/.
// - Keeps wrangler's local state (cache, traces) outside the repo too, so
//   nothing a request touches lands where repo tools can read it.
//
// Extra arguments pass through: npm run dev -- --port 8788
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { ENV_FILE } from "./access-code.mjs";

export { ENV_FILE };

// The command to run, as data, so tests can check it without spawning
export function devCommand({ extraArgs = [], envFileExists = existsSync(ENV_FILE), env = process.env } = {}) {
  // The local wrangler, run by this Node directly (no shell, no npx)
  const wrangler = fileURLToPath(new URL("../node_modules/wrangler/bin/wrangler.js", import.meta.url));
  const args = [wrangler, "dev", "--persist-to", join(tmpdir(), "transit-ics-wrangler-state")];
  if (envFileExists) args.push("--env-file", ENV_FILE);
  return {
    command: process.execPath,
    args: [...args, ...extraArgs],
    env: { ...env, X_LOCAL_OBSERVABILITY: "false" },
    warning: envFileExists ? null : `No ${ENV_FILE}: /wsf.ics will return 500 until it exists (see README, "WSDOT access code").`,
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { command, args, env, warning } = devCommand({ extraArgs: process.argv.slice(2) });
  if (warning) console.warn(warning);
  const child = spawn(command, args, { stdio: "inherit", env });
  child.on("exit", (code, signal) => process.exit(signal ? 1 : code ?? 0));
}
