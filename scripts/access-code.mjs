// Values kept outside the repo, and how to read them: the WSDOT access code
// (ADR 7) and this project's Cloudflare account ID (ADR 9).
// Shared by npm run dev, npm run secret:put, scripts/wrangler.mjs and
// test/no-leaks.test.js.
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// Outside the working tree, so no tool working in the repo can read or commit them.
// Two files: ENV_FILE goes to `wrangler dev --env-file`, which would hand
// anything else in it to the local Worker.
export const ENV_FILE = join(homedir(), ".secrets", "transit-ics.dev.vars");
export const DEPLOY_FILE = join(homedir(), ".secrets", "transit-ics.deploy.vars");

// dotenv's own line pattern (the one wrangler bundles), so we read exactly the
// value wrangler loads: quotes stripped, unquoted values cut at "#"
const DOTENV_LINE = /(?:^|^)\s*(?:export\s+)?([\w.-]+)(?:\s*=\s*?|:\s+?)(\s*'(?:\'|[^'])*'|\s*"(?:\\"|[^"])*"|\s*`(?:\`|[^`])*`|[^#\r\n]+)?\s*(?:#.*)?(?:$|$)/mg;
const MIN_LENGTH = 8;
const ACCOUNT_ID = /^[0-9a-f]{32}$/i;

// Every value assigned to key in the file, in order (dotenv uses the last; an
// older one left above it is still a secret), or null if the file is absent.
// Throws, without the value, if the file exists but has no assignment or any
// fails isUsable, so nobody scans for or uses a blank or mistyped value.
export function readVars(path, key, isUsable) {
  let text;
  try {
    text = readFileSync(path, "utf8");
  } catch (e) {
    if (e.code === "ENOENT") return null;
    throw new Error(`can't read ${path}: ${e.code}`);
  }
  const values = [...text.replace(/\r\n?/g, "\n").matchAll(DOTENV_LINE)]
    .filter(([, k]) => k === key)
    .map(([, , v = ""]) => v.trim().replace(/^(['"`])([\s\S]*)\1$/, "$2"));
  if (!values.length || !values.every(isUsable)) throw new Error(`${path} has no usable ${key}`);
  return values;
}

// Judge the value after trimming, as wrangler trims before uploading
export function readAccessCodes(path = ENV_FILE) {
  return readVars(path, "WSF_API_ACCESS_CODE", (v) => v.trim().length >= MIN_LENGTH);
}

export function readAccountIds(path = DEPLOY_FILE) {
  return readVars(path, "CLOUDFLARE_ACCOUNT_ID", (v) => ACCOUNT_ID.test(v));
}
