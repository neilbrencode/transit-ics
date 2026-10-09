// Guards against committing a real *.workers.dev hostname. The account
// subdomain is the only unguessable part of the Worker's public URL, so it is
// kept out of this repo (see "Keep the hostname out of git" in
// docs/runbook-cloudflare.md). That prevents accidental disclosure; it is
// obscurity, not access control.
//
// Limits: scans files in the working tree (tracked, plus untracked files that
// aren't ignored). It does not see commit messages, history, PRs or issues,
// and it can't detect personal names.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  lstatSync, mkdtempSync, mkdirSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// The only hostnames that may appear: documented placeholders
const ALLOWED = new Set([
  "transit-ics.<subdomain>.workers.dev",
  "<worker-name>.<subdomain>.workers.dev",
]);
const HOST = /[A-Za-z0-9<>._-]+\.workers\.dev/gi;

function findLeaks(text) {
  const leaks = [];
  text.split(/\r?\n/).forEach((line, i) => {
    for (const [match] of line.matchAll(HOST)) {
      if (!ALLOWED.has(match)) leaks.push({ line: i + 1, match });
    }
  });
  return leaks;
}

// Every non-ignored file in the working tree: its path, plus its contents read
// as latin1 so any bytes (binary included) are scanned rather than skipped.
// Symlinks are scanned by target text (what git stores), not followed.
// Path hits are reported as line 0. Throws if git fails.
function scanRepo(root) {
  const out = execFileSync("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], { cwd: root });
  const files = out.toString("utf8").split("\0").filter(Boolean);
  const leaks = [];
  for (const file of files) {
    for (const { match } of findLeaks(file)) leaks.push({ file, line: 0, match });
    const path = join(root, file);
    let text;
    try {
      text = lstatSync(path).isSymbolicLink() ? readlinkSync(path) : readFileSync(path, "latin1");
    } catch (e) {
      if (e.code === "ENOENT") continue; // tracked but deleted locally
      throw e;
    }
    for (const leak of findLeaks(text)) leaks.push({ file, ...leak });
  }
  return { files, leaks };
}

// Builds a hostname without writing one literally, so this file passes its own scan
const host = (...labels) => [...labels, "workers", "dev"].join(".");

test("placeholder hostnames are allowed", () => {
  for (const ok of ALLOWED) assert.deepEqual(findLeaks(`see https://${ok}/transit.ics`), []);
});

test("concrete, odd-placeholder, mixed-case and preview hostnames are leaks", () => {
  const cases = [
    host("transit-ics", "abc123"),
    host("abc123"),
    host("other-worker", "abc123"),
    host("<prod>"),
    host("transit-ics", "<actual>"),
    ["TRANSIT-ICS", "<subdomain>", "WORKERS", "DEV"].join("."),
    host("0a1b2c3d-transit-ics", "abc123"), // preview URL shape
  ];
  for (const h of cases) {
    assert.deepEqual(findLeaks(`x\n(https://${h}/transit.ics).`), [{ line: 2, match: h }], h);
  }
});

test("scanner reports leaks in contents, binaries and file names, with file and line; skips ignored", () => {
  const dir = mkdtempSync(join(tmpdir(), "no-leaks-"));
  try {
    // A global core.autocrlf=true would print LF/CRLF warnings on add
    const git = (...args) => execFileSync("git", ["-c", "core.autocrlf=false", ...args], { cwd: dir });
    git("init", "-q");
    mkdirSync(join(dir, "dir with space"));
    writeFileSync(join(dir, "dir with space", "tracked é.md"), `a\nb\n${host("transit-ics", "abc123")}\n`);
    writeFileSync(join(dir, `notes-${host("abc123")}.txt`), "");
    writeFileSync(join(dir, ".gitignore"), "ignored.log\n");
    git("add", ".");
    writeFileSync(join(dir, "untracked.txt"), host("abc123"));
    writeFileSync(join(dir, "ignored.log"), host("abc123"));
    writeFileSync(join(dir, "blob.bin"), Buffer.concat([Buffer.from([0, 0xff, 0x0a]), Buffer.from(host("abc123"))]));

    const { leaks } = scanRepo(dir);
    assert.deepEqual(
      leaks.map(({ file, line }) => `${file}:${line}`).sort(),
      ["blob.bin:2", "dir with space/tracked é.md:3", `notes-${host("abc123")}.txt:0`, "untracked.txt:1"],
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("scanner reads symlink targets instead of following them", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "no-leaks-"));
  try {
    execFileSync("git", ["init", "-q"], { cwd: dir });
    try { symlinkSync(join("missing", host("abc123")), join(dir, "link")); }
    catch (e) {
      // Windows needs Developer Mode or admin rights for symlinks; CI (Linux) always runs this
      if (e.code === "EPERM") return t.skip("symlinks not permitted on this machine");
      throw e;
    }
    const { leaks } = scanRepo(dir);
    assert.deepEqual(leaks.map(({ file, line }) => `${file}:${line}`), ["link:1"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("scanner fails loudly outside a git repository", () => {
  const dir = mkdtempSync(join(tmpdir(), "no-leaks-"));
  try { assert.throws(() => scanRepo(dir)); }
  finally { rmSync(dir, { recursive: true, force: true }); }
});

test("no real *.workers.dev hostname is committed", () => {
  const { files, leaks } = scanRepo(fileURLToPath(new URL("..", import.meta.url)));
  assert.ok(files.length > 0, "scanned no files");
  // Report location only, so a failing CI log doesn't echo the hostname
  assert.deepEqual(leaks.map(({ file, line }) => `${file}:${line}`), []);
});
