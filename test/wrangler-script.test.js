// scripts/wrangler.mjs pins wrangler to this project's Cloudflare account
// (ADR 9). The process runners are fakes: nothing is spawned, and each test
// checks what would have run, in what order, with what environment.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { CONFIG, checkConfig, run } from "../scripts/wrangler.mjs";
import { putSecret } from "../scripts/put-secret.mjs";

// Synthetic account IDs: the expected one, and another the login can reach
const EXPECTED = "0123456789abcdef0123456789abcdef";
const OTHER = "fedcba9876543210fedcba9876543210";

function fakes({
  ids = [EXPECTED], whoami = { status: 0, stdout: JSON.stringify({ accounts: [{ id: EXPECTED }] }) },
  config = 'name = "transit-ics"\n', dotEnv = [], env = { PATH: "x" }, status = 0,
} = {}) {
  const calls = [];
  const logs = [];
  const deps = {
    env,
    readIds: () => (typeof ids === "function" ? ids() : ids),
    readConfig: () => config,
    dotEnvExists: (file) => dotEnv.includes(file),
    capture: async (argv, childEnv) => { calls.push({ kind: "capture", argv, env: childEnv }); return whoami; },
    start: async (argv, childEnv, input) => { calls.push({ kind: "start", argv, env: childEnv, input }); return status; },
    log: (message) => logs.push(message),
  };
  return { calls, logs, deps };
}
const accounts = (...list) => ({ status: 0, stdout: JSON.stringify({ loggedIn: true, accounts: list.map((id) => ({ id })) }) });
const noIds = (logs) => !logs.join("\n").toLowerCase().includes(EXPECTED) && !logs.join("\n").toLowerCase().includes(OTHER);

test("deploy checks the login first, then runs pinned to the expected account with the repo config", async () => {
  const { calls, deps } = fakes({
    env: { PATH: "x", CLOUDFLARE_ENV: "staging", cloudflare_env: "x", WRANGLER_LOG: "debug", WRANGLER_LOG_SANITIZE: "false" },
  });
  assert.equal(await run(["deploy"], deps), 0);
  assert.deepEqual(calls.map((c) => c.kind), ["capture", "start"]);
  const [whoami, deploy] = calls;
  assert.deepEqual(whoami.argv.slice(1), ["whoami", "--json", "--config", CONFIG]);
  assert.deepEqual(deploy.argv.slice(1), ["deploy", "--config", CONFIG]);
  assert.ok(existsSync(deploy.argv[0]), "local wrangler must be installed");
  for (const { env } of calls) {
    assert.equal(env.CLOUDFLARE_ACCOUNT_ID, EXPECTED);
    assert.equal(env.WRANGLER_LOG_SANITIZE, "true");
    assert.equal(env.PATH, "x");
    assert.ok(!Object.keys(env).some((k) => ["CLOUDFLARE_ENV", "WRANGLER_LOG"].includes(k.toUpperCase())), "env selection and debug logging removed");
  }
});

test("a login that reaches both accounts still targets only the expected one", async () => {
  const { calls, deps } = fakes({ whoami: accounts(OTHER, EXPECTED) });
  assert.equal(await run(["deploy"], deps), 0);
  assert.equal(calls.at(-1).env.CLOUDFLARE_ACCOUNT_ID, EXPECTED);
});

test("signed in to another account, signed out, or unreadable whoami: refused before anything changes", async () => {
  for (const whoami of [
    accounts(OTHER), accounts(), { status: 1, stdout: "" }, { status: 0, stdout: "not json" },
    { status: 0, stdout: JSON.stringify({ loggedIn: false }) },
  ]) {
    const { calls, logs, deps } = fakes({ whoami });
    assert.equal(await run(["deploy"], deps), 1);
    assert.deepEqual(calls.map((c) => c.kind), ["capture"], "only the whoami check ran");
    assert.match(logs.join("\n"), /different Cloudflare account, or not signed in/);
    assert.ok(noIds(logs), "message must not contain an account ID");
  }
});

test("flags that pick another config, directory, environment, login or account are refused, in every spelling", async () => {
  for (const args of [
    ["deploy", "--config", "other.toml"], ["deploy", "--config=other.toml"], ["deploy", "-c", "x"], ["deploy", "-cx"],
    ["deploy", "--cwd", ".."], ["deploy", "--env", "prod"], ["deploy", "-e", "prod"], ["deploy", "-e=prod"],
    ["deploy", "--env-file", ".env"], ["deploy", "--envFile=.env"], ["deploy", "--ENV-FILE", "x"], ["deploy", "--no-env-file"],
    ["deploy", "--temporary"], ["deploy", "--event-code", "x"], ["deploy", "--eventCode=x"], ["deploy", "--profile", "work"],
    ["rollback", "abc", "-m", "x", "-ce", "y"],
  ]) {
    const { calls, logs, deps } = fakes();
    assert.equal(await run(args, deps), 1, args.join(" "));
    assert.deepEqual(calls, [], `${args.join(" ")}: nothing spawned`);
    assert.match(logs[0], /isn't allowed/);
  }
});

test("allowed flags pass, and --config goes before any --", async () => {
  const { calls, deps } = fakes();
  assert.equal(await run(["rollback", "abc", "-m", "reason", "--", "x"], deps), 0);
  assert.deepEqual(calls.at(-1).argv.slice(1), ["rollback", "--config", CONFIG, "abc", "-m", "reason", "--", "x"]);
  const second = fakes();
  assert.equal(await run(["deployments", "list"], second.deps), 0);
  assert.deepEqual(second.calls.at(-1).argv.slice(1), ["deployments", "list", "--config", CONFIG]);
});

test("commands outside the list are refused", async () => {
  for (const args of [[], ["login"], ["dev"], ["kv", "namespace", "list"], ["deployments"], ["secret"]]) {
    const { calls, logs, deps } = fakes();
    assert.equal(await run(args, deps), 1, args.join(" "));
    assert.deepEqual(calls, []);
    assert.match(logs[0], /supports only/);
  }
});

test("a config that sets an account, in any quoting, table or escape, is refused", async () => {
  for (const config of [
    `account_id = "${OTHER}"\n`, `"account_id" = "${OTHER}"\n`, `'account_id' = "${OTHER}"\n`,
    `name = "x"\n[env.prod]\naccount_id = "${OTHER}"\n`, `"account\\u005fid" = "${OTHER}"\n`, "# ACCOUNT_ID in a comment\n",
  ]) {
    const { calls, logs, deps } = fakes({ config });
    assert.equal(await run(["deploy"], deps), 1, config);
    assert.deepEqual(calls, []);
    assert.match(logs[0], /must not set an account/);
    assert.ok(noIds(logs));
  }
});

test("the repo's wrangler.toml passes, and is the absolute path wrangler is given", () => {
  assert.ok(isAbsolute(CONFIG));
  assert.equal(checkConfig(readFileSync(CONFIG, "utf8")), null);
});

test(".env files in the repo are refused (wrangler would load them)", async () => {
  for (const file of [".env", ".env.local"]) {
    const { calls, logs, deps } = fakes({ dotEnv: [file] });
    assert.equal(await run(["deploy"], deps), 1);
    assert.deepEqual(calls, []);
    assert.match(logs[0], new RegExp(`Remove \\${file} `));
  }
});

test("no expected account, or an unusable file: refused with instructions, nothing spawned", async () => {
  const missing = fakes({ ids: null });
  assert.equal(await run(["deploy"], missing.deps), 1);
  assert.deepEqual(missing.calls, []);
  assert.match(missing.logs[0], /save CLOUDFLARE_ACCOUNT_ID=<id> there first/);

  const bad = fakes({ ids: () => { throw new Error("x.deploy.vars has no usable CLOUDFLARE_ACCOUNT_ID"); } });
  assert.equal(await run(["deploy"], bad.deps), 1);
  assert.deepEqual(bad.calls, []);
  assert.match(bad.logs[0], /no usable/);
});

test("the last ID in the file is used; an inherited CLOUDFLARE_ACCOUNT_ID must match it", async () => {
  const rotated = fakes({ ids: [OTHER, EXPECTED] });
  assert.equal(await run(["deploy"], rotated.deps), 0);
  assert.equal(rotated.calls.at(-1).env.CLOUDFLARE_ACCOUNT_ID, EXPECTED);

  const conflict = fakes({ env: { cloudflare_account_id: OTHER } });
  assert.equal(await run(["deploy"], conflict.deps), 1);
  assert.deepEqual(conflict.calls, []);
  assert.match(conflict.logs[0], /doesn't match/);
  assert.ok(noIds(conflict.logs));

  const same = fakes({ env: { CLOUDFLARE_ACCOUNT_ID: EXPECTED.toUpperCase() } });
  assert.equal(await run(["deploy"], same.deps), 0);
});

test("wrangler's exit status is the wrapper's", async () => {
  const { deps } = fakes({ status: 3 });
  assert.equal(await run(["deploy"], deps), 3);
});

// --- npm run secret:put goes through the same check -------------------------

test("secret:put: code only on stdin, pinned, after the account check", async () => {
  const dir = mkdtempSync(join(tmpdir(), "put-secret-"));
  try {
    const path = join(dir, "x.dev.vars");
    writeFileSync(path, "WSF_API_ACCESS_CODE=synthetic-code-5678\n");
    const ok = fakes();
    assert.equal(await putSecret({ path, ...ok.deps }), 0);
    assert.deepEqual(ok.calls.map((c) => c.kind), ["capture", "start"]);
    const upload = ok.calls.at(-1);
    assert.deepEqual(upload.argv.slice(1), ["secret", "put", "--config", CONFIG, "WSF_API_ACCESS_CODE"]);
    assert.equal(upload.input, "synthetic-code-5678");
    assert.ok(!JSON.stringify([upload.argv, upload.env]).includes("synthetic-code"), "code never in arguments or environment");
    assert.equal(upload.env.CLOUDFLARE_ACCOUNT_ID, EXPECTED);
    assert.equal(upload.env.WRANGLER_LOG_SANITIZE, "true");

    const wrong = fakes({ whoami: accounts(OTHER) });
    assert.equal(await putSecret({ path, ...wrong.deps }), 1);
    assert.deepEqual(wrong.calls.map((c) => c.kind), ["capture"], "no upload");

    const noCode = fakes();
    assert.equal(await putSecret({ path: join(dir, "missing.dev.vars"), ...noCode.deps }), 1);
    assert.deepEqual(noCode.calls, []);
    assert.match(noCode.logs[0], /save the code there first/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
