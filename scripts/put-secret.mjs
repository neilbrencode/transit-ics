// npm run secret:put: upload the WSDOT access code to the Worker (ADR 7)
//
// Reads the code from outside the repo (ENV_FILE), refuses a missing or blank
// one, and pipes it to `wrangler secret put` on stdin, so it is never typed,
// displayed or passed as a command-line argument. Wrangler itself uploads a
// blank value when stdin is empty, which would break /wsf.ics with a 500.
// Runs through scripts/wrangler.mjs, so it is pinned to this project's
// Cloudflare account and wrangler's log sanitising is forced on (ADR 9).
import { fileURLToPath } from "node:url";
import { ENV_FILE, readAccessCodes } from "./access-code.mjs";
import { run } from "./wrangler.mjs";

// The code to upload (the last assignment, as dotenv/wrangler would load it)
export function codeToUpload(path = ENV_FILE) {
  const codes = readAccessCodes(path);
  if (codes === null) throw new Error(`No ${path}: save the code there first (see README, "WSDOT access code").`);
  return codes.at(-1);
}

export const UPLOAD_ARGS = ["secret", "put", "WSF_API_ACCESS_CODE"];

// Upload the code. deps are passed to run(), so tests can inject the processes.
export async function putSecret({ path = ENV_FILE, log = console.error, ...deps } = {}) {
  let code;
  try {
    code = codeToUpload(path);
  } catch (e) {
    log(e.message);
    return 1;
  }
  return run(UPLOAD_ARGS, { ...deps, log, input: code });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  process.exitCode = await putSecret();
}
