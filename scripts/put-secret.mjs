// npm run secret:put: upload the WSDOT access code to the Worker (ADR 7)
//
// Reads the code from outside the repo (ENV_FILE), refuses a missing or blank
// one, and pipes it to `wrangler secret put` on stdin, so it is never typed,
// displayed or passed as a command-line argument. Wrangler itself uploads a
// blank value when stdin is empty, which would break /wsf.ics with a 500.
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { ENV_FILE, readAccessCodes } from "./access-code.mjs";

// The code to upload (the last assignment, as dotenv/wrangler would load it)
export function codeToUpload(path = ENV_FILE) {
  const codes = readAccessCodes(path);
  if (codes === null) throw new Error(`No ${path}: save the code there first (see README, "WSDOT access code").`);
  return codes.at(-1);
}

// The upload command, as data, so tests can check it without spawning.
// WRANGLER_LOG_SANITIZE=false would make wrangler's debug log include the
// request body, code included, so it is forced on whatever the shell says.
export function uploadCommand(env = process.env) {
  const wrangler = fileURLToPath(new URL("../node_modules/wrangler/bin/wrangler.js", import.meta.url));
  return {
    command: process.execPath,
    args: [wrangler, "secret", "put", "WSF_API_ACCESS_CODE"],
    env: { ...env, WRANGLER_LOG_SANITIZE: "true" },
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  let code;
  try {
    code = codeToUpload();
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }
  const { command, args, env } = uploadCommand();
  const child = spawn(command, args, { stdio: ["pipe", "inherit", "inherit"], env });
  child.stdin.end(code);
  child.on("exit", (status, signal) => process.exit(signal ? 1 : status ?? 0));
}
