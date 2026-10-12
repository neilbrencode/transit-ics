// Where the WSDOT access code lives on this machine, and how to read it (ADR 7).
// Shared by npm run dev, npm run secret:put and test/no-leaks.test.js.
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// Outside the working tree, so no tool working in the repo can read or commit it
export const ENV_FILE = join(homedir(), ".secrets", "transit-ics.dev.vars");

// dotenv's own line pattern (the one wrangler bundles), so we read exactly the
// value wrangler loads: quotes stripped, unquoted values cut at "#"
const DOTENV_LINE = /(?:^|^)\s*(?:export\s+)?([\w.-]+)(?:\s*=\s*?|:\s+?)(\s*'(?:\\'|[^'])*'|\s*"(?:\\"|[^"])*"|\s*`(?:\\`|[^`])*`|[^#\r\n]+)?\s*(?:#.*)?(?:$|$)/mg;
const MIN_LENGTH = 8;

// Every access code assigned in the file, in order (dotenv uses the last; an
// older one left above it is still a secret), or null if the file is absent.
// Throws, without the value, if the file exists but any assignment is empty or
// too short, so nobody scans for or uploads a blank code.
export function readAccessCodes(path = ENV_FILE) {
  let text;
  try {
    text = readFileSync(path, "utf8");
  } catch (e) {
    if (e.code === "ENOENT") return null;
    throw new Error(`can't read ${path}: ${e.code}`);
  }
  const values = [...text.replace(/\r\n?/g, "\n").matchAll(DOTENV_LINE)]
    .filter(([, key]) => key === "WSF_API_ACCESS_CODE")
    .map(([, , v = ""]) => v.trim().replace(/^(['"`])([\s\S]*)\1$/, "$2"));
  // Judge the value after trimming, as wrangler trims before uploading
  if (!values.length || values.some((v) => v.trim().length < MIN_LENGTH)) {
    throw new Error(`${path} has no usable WSF_API_ACCESS_CODE`);
  }
  return values;
}
