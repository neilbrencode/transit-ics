// Guards against committing a real *.workers.dev hostname. The account
// subdomain is the only unguessable part of the Worker's public URL, so it is
// kept out of this repo (see "Keep the hostname out of git" in
// docs/runbook-cloudflare.md). That prevents accidental disclosure; it is
// obscurity, not access control.
//
// Also guards the WSDOT access code (ADR 7). It lives outside the repo, in
// ENV_FILE (scripts/access-code.mjs). When that file exists, this test reads
// it on purpose and fails if the value appears in any file, reporting
// file:line only, never the value. CI has no such file, so there the scanner
// is proven with a synthetic secret instead.
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
import { ENV_FILE, readAccessCodes } from "../scripts/access-code.mjs";

// The only hostnames that may appear: documented placeholders
const ALLOWED = new Set([
  "transit-ics.<subdomain>.workers.dev",
  "<worker-name>.<subdomain>.workers.dev",
]);
const HOST = /[A-Za-z0-9<>._-]+\.workers\.dev/gi;

// Secret hits are reported as this label, so a failure never prints the value
const SECRET = "<secret>";

// An ASCII secret as it appears in a UTF-16 file read as latin1 (NUL between
// characters, either byte order), e.g. a file Windows PowerShell 5.1 wrote
const utf16 = (s) => s.split("").join("\0");

function findLeaks(text, secrets = []) {
  const leaks = [];
  text.split(/\r?\n/).forEach((line, i) => {
    for (const [match] of line.matchAll(HOST)) {
      if (!ALLOWED.has(match)) leaks.push({ line: i + 1, match });
    }
    if (secrets.some((s) => line.includes(s) || line.includes(utf16(s)))) leaks.push({ line: i + 1, match: SECRET });
  });
  return leaks;
}

// Every non-ignored file in the working tree: its path, plus its contents read
// as latin1 so any bytes (binary included) are scanned rather than skipped.
// Symlinks are scanned by target text (what git stores), not followed.
// Path hits are reported as line 0. Reported paths have any secret replaced
// by SECRET, since a file name can carry one too. Throws if git fails.
function scanRepo(root, secrets = []) {
  const out = execFileSync("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], { cwd: root });
  const files = out.toString("utf8").split("\0").filter(Boolean);
  const leaks = [];
  for (const file of files) {
    const shown = secrets.reduce((name, s) => name.split(s).join(SECRET), file);
    for (const { match } of findLeaks(file, secrets)) leaks.push({ file: shown, line: 0, match });
    const path = join(root, file);
    let text;
    try {
      text = lstatSync(path).isSymbolicLink() ? readlinkSync(path) : readFileSync(path, "latin1");
    } catch (e) {
      if (e.code === "ENOENT") continue; // tracked but deleted locally
      throw new Error(`can't read ${shown}: ${e.code}`); // e.message would include the raw path
    }
    for (const leak of findLeaks(text, secrets)) leaks.push({ file: shown, ...leak });
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

test("secret scanner finds a synthetic code in tracked and untracked files, skips ignored, never prints it", () => {
  const secret = "SYNTH-3f9a2c71-secret";
  const dir = mkdtempSync(join(tmpdir(), "no-leaks-"));
  try {
    const git = (...args) => execFileSync("git", ["-c", "core.autocrlf=false", ...args], { cwd: dir });
    git("init", "-q");
    writeFileSync(join(dir, "tracked.js"), `a\nconst k = "${secret}";\n`);
    writeFileSync(join(dir, ".gitignore"), ".dev.vars\n");
    git("add", ".");
    writeFileSync(join(dir, "untracked.md"), `see apiaccesscode=${secret}`);
    writeFileSync(join(dir, `alerts-${secret}.json`), "{}");
    writeFileSync(join(dir, ".dev.vars"), `WSF_API_ACCESS_CODE=${secret}\n`);
    // UTF-16 files, as Windows PowerShell 5.1 writes them, in both byte orders
    writeFileSync(join(dir, "notes-utf16le.txt"), Buffer.from(`﻿x\r\ncode ${secret}\r\n`, "utf16le"));
    writeFileSync(join(dir, "notes-utf16be.txt"), Buffer.from(`y ${secret}`, "utf16le").swap16());

    const { leaks } = scanRepo(dir, [secret]);
    assert.deepEqual(
      leaks.map(({ file, line }) => `${file}:${line}`).sort(),
      ["alerts-<secret>.json:0", "notes-utf16be.txt:1", "notes-utf16le.txt:2", "tracked.js:2", "untracked.md:1"],
    );
    assert.ok(leaks.every(({ match }) => match === SECRET));
    assert.ok(!JSON.stringify(leaks).includes(secret), "leak report must not contain the value");
    assert.deepEqual(scanRepo(dir).leaks, [], "no needles, no secret findings");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("access code reader: absent file is null; a present file must hold a usable code", () => {
  const dir = mkdtempSync(join(tmpdir(), "no-leaks-"));
  try {
    const file = join(dir, "x.dev.vars");
    assert.equal(readAccessCodes(file), null);
    for (const content of [
      "WSF_API_ACCESS_CODE=abcdef123456\n",
      'OTHER=1\r\nWSF_API_ACCESS_CODE="abcdef123456"\r\n',
      "WSF_API_ACCESS_CODE='abcdef123456'\n",
      "WSF_API_ACCESS_CODE=abcdef123456 # from WSDOT\n",
      "WSF_API_ACCESS_CODE=abcdef123456#no space before the comment\n",
      "WSF_API_ACCESS_CODE=\"abcdef123456\" # quoted, then a comment\n",
      "export WSF_API_ACCESS_CODE = abcdef123456\n",
    ]) {
      writeFileSync(file, content);
      assert.deepEqual(readAccessCodes(file), ["abcdef123456"]);
    }
    // Rotation: dotenv uses the last assignment, but both are scanned
    writeFileSync(file, "WSF_API_ACCESS_CODE=old-code-1234\nWSF_API_ACCESS_CODE=new-code-5678\n");
    assert.deepEqual(readAccessCodes(file), ["old-code-1234", "new-code-5678"]);
    for (const content of [
      "", "WSF_API_ACCESS_CODE=\n", "WSF_API_ACCESS_CODE=short\n", "WSDOT_KEY=abcdef123456\n",
      "WSF_API_ACCESS_CODE=abcdef123456\nWSF_API_ACCESS_CODE=\n",
    ]) {
      writeFileSync(file, content);
      assert.throws(() => readAccessCodes(file), (e) => !/abcdef|short/.test(e.message));
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the real WSDOT access code is not in any committed or committable file", (t) => {
  const codes = readAccessCodes(ENV_FILE);
  if (codes === null) return t.skip("no access code file on this machine (normal in CI)");
  const { files, leaks } = scanRepo(fileURLToPath(new URL("..", import.meta.url)), codes);
  assert.ok(files.length > 0, "scanned no files");
  // Location only: the value itself must never reach a test log
  assert.deepEqual(leaks.filter(({ match }) => match === SECRET).map(({ file, line }) => `${file}:${line}`), []);
});
