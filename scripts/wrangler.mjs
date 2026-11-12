// npm run deploy, npm run wrangler -- <command>: wrangler pinned to this
// project's Cloudflare account (ADR 9)
//
// Wrangler's login is shared by every project on the machine, so a deploy
// signed in to another project's account silently creates a Worker there.
// This runs the local wrangler with CLOUDFLARE_ACCOUNT_ID from a file outside
// the repo (DEPLOY_FILE), after ruling out everything that outranks that
// variable or changes the target: an account in the config, other config
// files, named environments, .env files, temporary accounts and auth profiles.
// It then checks that the login can reach that account before running.
//
// Its own messages never name an account. Wrangler's output passes through
// unchanged and can (ADR 9).
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { DEPLOY_FILE, readAccountIds } from "./access-code.mjs";

const REPO = fileURLToPath(new URL("..", import.meta.url));
export const CONFIG = join(REPO, "wrangler.toml");
const WRANGLER = join(REPO, "node_modules", "wrangler", "bin", "wrangler.js");

// The commands this project uses that talk to Cloudflare
const COMMANDS = [
  "deploy", "rollback", "deployments list", "versions list", "versions view",
  "secret list", "secret put", "secret delete", "delete", "tail", "whoami",
].map((c) => c.split(" "));
// Flags that pick another config, directory, environment, env file, login or
// account. Compared without dashes or case, as yargs accepts --env-file,
// --envFile and --no-env-file alike.
const BLOCKED_FLAGS = new Set(["config", "c", "cwd", "env", "e", "envfile", "temporary", "eventcode", "profile"]);
const BLOCKED_SHORT = /[ce]/; // -c, -e, and groups such as -ce
// Wrangler loads these from its working directory into its own environment,
// so they could set CLOUDFLARE_ENV after we've removed it
const DOT_ENV_FILES = [".env", ".env.local"];
// Replaced or removed in wrangler's environment. Matched ignoring case, since
// Windows environment names are case-insensitive.
const DROPPED_ENV = new Set(["CLOUDFLARE_ACCOUNT_ID", "CLOUDFLARE_ENV", "WRANGLER_LOG", "WRANGLER_LOG_SANITIZE"]);

const WRONG_ACCOUNT = "Wrangler is signed in to a different Cloudflare account, or not signed in. Run `npx wrangler login` with the transit-ics account (see docs/runbook-cloudflare.md).";

// The matched command's words, or null
export function commandOf(args) {
  return COMMANDS.find((words) => words.every((w, i) => args[i] === w)) ?? null;
}

// Why args are refused, or null
export function checkArgs(args) {
  if (!commandOf(args)) return `npm run wrangler supports only: ${COMMANDS.map((w) => w.join(" ")).join(", ")}.`;
  for (const arg of args) {
    if (arg === "--") break;
    const name = arg.split("=")[0];
    const long = name.startsWith("--") && BLOCKED_FLAGS.has(name.slice(2).replace(/^no-/i, "").replace(/-/g, "").toLowerCase());
    const short = /^-[^-]/.test(name) && BLOCKED_SHORT.test(name.slice(1));
    if (long || short) return `${name} isn't allowed: the account, config and environment are fixed for this project (ADR 9).`;
  }
  return null;
}

// Why the config is refused, or null. Any mention of account_id, in any
// quoting or a comment, fails, as does any \u escape (a key could spell it
// that way), so no TOML parsing is needed to be sure there's no account in it.
export function checkConfig(text) {
  return /account_id|\\u/i.test(text)
    ? "wrangler.toml must not set an account (ADR 9): remove account_id from it."
    : null;
}

// Wrangler's environment: the account pinned, log sanitising on, nothing that
// selects an environment or turns on debug logging (which prints request URLs)
export function childEnv(env, accountId) {
  const kept = Object.entries(env).filter(([k]) => !DROPPED_ENV.has(k.toUpperCase()));
  return { ...Object.fromEntries(kept), CLOUDFLARE_ACCOUNT_ID: accountId, WRANGLER_LOG_SANITIZE: "true" };
}

// Whether `wrangler whoami --json` output shows a login that reaches accountId
export function reaches({ status, stdout }, accountId) {
  if (status !== 0) return false;
  try {
    const { accounts } = JSON.parse(stdout);
    return Array.isArray(accounts) && accounts.some((a) => String(a?.id).toLowerCase() === accountId);
  } catch {
    return false;
  }
}

// Run wrangler with args, pinned. Resolves to the exit status. Every check
// happens before anything that can change Cloudflare is spawned. The process
// functions are injectable so tests can check the order without spawning.
export async function run(args, {
  env = process.env,
  readIds = readAccountIds,
  readConfig = () => readFileSync(CONFIG, "utf8"),
  dotEnvExists = (file) => existsSync(join(REPO, file)),
  capture = captureWrangler,
  start = startWrangler,
  log = console.error,
  input,
} = {}) {
  const refuse = (message) => { log(message); return 1; };

  const badArgs = checkArgs(args);
  if (badArgs) return refuse(badArgs);
  const badConfig = checkConfig(readConfig());
  if (badConfig) return refuse(badConfig);
  const dotEnv = DOT_ENV_FILES.find(dotEnvExists);
  if (dotEnv) return refuse(`Remove ${dotEnv} from the repo: wrangler would load it into its environment (ADR 9).`);

  let ids;
  try {
    ids = readIds();
  } catch (e) {
    return refuse(e.message); // names the file and key, never the value
  }
  if (ids === null) {
    return refuse(`No ${DEPLOY_FILE}: save CLOUDFLARE_ACCOUNT_ID=<id> there first (see docs/runbook-cloudflare.md, "Save the expected account").`);
  }
  const accountId = ids.at(-1).toLowerCase();
  const inherited = Object.entries(env).find(([k, v]) => k.toUpperCase() === "CLOUDFLARE_ACCOUNT_ID" && v);
  if (inherited && inherited[1].toLowerCase() !== accountId) {
    return refuse(`CLOUDFLARE_ACCOUNT_ID in your environment doesn't match ${DEPLOY_FILE}. Unset it, or fix the file.`);
  }

  const wranglerEnv = childEnv(env, accountId);
  const config = ["--config", CONFIG];
  if (!reaches(await capture([WRANGLER, "whoami", "--json", ...config], wranglerEnv), accountId)) {
    return refuse(WRONG_ACCOUNT);
  }
  // --config right after the command words, so a "--" in args can't make it positional
  const words = commandOf(args).length;
  return start([WRANGLER, ...args.slice(0, words), ...config, ...args.slice(words)], wranglerEnv, input);
}

// Runs wrangler with its output captured and never shown: { status, stdout }
function captureWrangler(argv, env) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, argv, { cwd: REPO, env, stdio: ["ignore", "pipe", "ignore"] });
    let stdout = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.on("error", () => resolve({ status: 1, stdout: "" }));
    child.on("close", (status) => resolve({ status: status ?? 1, stdout }));
  });
}

// Runs wrangler on the terminal, so its prompts work. With input, that goes to
// its stdin instead (never to its arguments or environment).
function startWrangler(argv, env, input) {
  return new Promise((resolve) => {
    const stdio = input === undefined ? "inherit" : ["pipe", "inherit", "inherit"];
    const child = spawn(process.execPath, argv, { cwd: REPO, env, stdio });
    if (input !== undefined) child.stdin.end(input);
    child.on("error", () => resolve(1));
    child.on("exit", (status, signal) => resolve(signal ? 1 : status ?? 0));
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  process.exitCode = await run(process.argv.slice(2));
}
