// scripts/dev.mjs builds the wrangler dev command that keeps the WSDOT access
// code out of the repo (ADR 7). Checked as data; nothing is spawned.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { ENV_FILE, devCommand } from "../scripts/dev.mjs";

test("with the secrets file: loads it, disables local tracing, keeps state outside the repo", () => {
  const { command, args, env, warning } = devCommand({
    envFileExists: true, extraArgs: ["--port", "8788"], env: { PATH: "x", X_LOCAL_OBSERVABILITY: "true" },
  });
  assert.equal(command, process.execPath);
  assert.ok(args[0].endsWith(join("node_modules", "wrangler", "bin", "wrangler.js")));
  assert.ok(existsSync(args[0]), "local wrangler must be installed");
  assert.deepEqual(args.slice(1), [
    "dev", "--persist-to", join(tmpdir(), "transit-ics-wrangler-state"), "--env-file", ENV_FILE, "--port", "8788",
  ]);
  assert.equal(env.X_LOCAL_OBSERVABILITY, "false", "must override an inherited value");
  assert.equal(env.PATH, "x");
  assert.equal(warning, null);
});

test("without the secrets file: still safe, no --env-file, and a warning", () => {
  const { args, env, warning } = devCommand({ envFileExists: false, env: {} });
  assert.ok(!args.includes("--env-file"));
  assert.ok(args.includes("--persist-to"));
  assert.equal(env.X_LOCAL_OBSERVABILITY, "false");
  assert.match(warning, /will return 500/);
});

test("the secrets file is outside the repo", () => {
  const repo = fileURLToPath(new URL("..", import.meta.url));
  assert.ok(!ENV_FILE.toLowerCase().startsWith(repo.toLowerCase()));
});
