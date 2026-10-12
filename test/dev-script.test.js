// scripts/dev.mjs and scripts/put-secret.mjs handle the WSDOT access code
// (ADR 7). Checked as data; nothing is spawned.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { ENV_FILE, devCommand } from "../scripts/dev.mjs";
import { codeToUpload, uploadCommand } from "../scripts/put-secret.mjs";

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

// --- scripts/put-secret.mjs --------------------------------------------------

test("secret:put uploads the last assigned code and refuses a missing or blank one", () => {
  const dir = mkdtempSync(join(tmpdir(), "put-secret-"));
  try {
    const file = join(dir, "x.dev.vars");
    assert.throws(() => codeToUpload(file), /save the code there first/);
    writeFileSync(file, "WSF_API_ACCESS_CODE=old-code-1234\nWSF_API_ACCESS_CODE=new-code-5678\n");
    assert.equal(codeToUpload(file), "new-code-5678");
    for (const content of [
      "WSF_API_ACCESS_CODE=\n",
      "OTHER=x\n",
      'WSF_API_ACCESS_CODE="        "\n', // quoted spaces: wrangler would trim this to blank
      "WSF_API_ACCESS_CODE=good-code-1234\nWSF_API_ACCESS_CODE=\n",
    ]) {
      writeFileSync(file, content);
      assert.throws(() => codeToUpload(file), (e) => /no usable/.test(e.message) && !/good-code/.test(e.message));
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("secret:put runs the local wrangler with log sanitising forced on, code only on stdin", () => {
  const { command, args, env } = uploadCommand({ PATH: "x", WRANGLER_LOG_SANITIZE: "false" });
  assert.equal(command, process.execPath);
  assert.ok(existsSync(args[0]), "local wrangler must be installed");
  assert.deepEqual(args.slice(1), ["secret", "put", "WSF_API_ACCESS_CODE"]);
  assert.equal(env.WRANGLER_LOG_SANITIZE, "true", "must override an inherited false");
  assert.equal(env.PATH, "x");
});
