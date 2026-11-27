#!/usr/bin/env node
// Checks the project lock's contract (lib/lock.mjs): a lock host that cannot be reached refuses the
// run unless `allowUnlocked` is given (EDU-1015), another holder is named, and the happy path takes
// and releases the row. No Tiger Cloud: a fake `tiger` and a fake `psql` on PATH stand in for the CLI
// and the lock host, each case in a child process with the ids set or empty as the case needs.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

let failed = 0;
const check = (name, fn) => {
  try { fn(); console.log(`  ok   ${name}`); } catch (e) { failed++; console.log(`  FAIL ${name}\n       ${String(e.message).split("\n").join("\n       ")}`); }
};
const LIB = fileURLToPath(new URL("../lib/", import.meta.url));
const bin = mkdtempSync(join(tmpdir(), "check-lock-"));
const fake = (name, body) => { writeFileSync(join(bin, name), `#!/bin/sh\n${body}\n`); chmodSync(join(bin, name), 0o755); };
// The fake CLI hands out a connection string; the fake psql's behaviour is picked per case by PSQL_MODE.
fake("tiger", `echo "postgresql://u:p@lock-host.example:5432/tsdb"`);
fake("psql", `case "$PSQL_MODE" in
  down) echo "psql: error: connection to server at \\"lock-host.example\\" failed: Connection refused" >&2; exit 2 ;;
  held) echo "other-machine:4242|security/members|2026-11-27 09:12Z" ;;
  *) echo "$(hostname):$PPID|the page|2026-11-27 09:30Z" ;;
esac`);
const IDS = { DOCTEST_PROJECT_ID: "proj000001", DOCTEST_SERVICE_AWS: "awsaws0001", DOCTEST_SERVICE_AZURE: "azure00001", DOCTEST_TFSTATE_BUCKET: "" };
const run = (code, env) => {
  const r = spawnSync(process.execPath, ["--input-type=module", "-e", `import * as s from ${JSON.stringify(LIB + "services.mjs")}; import { acquireRunLock } from ${JSON.stringify(LIB + "lock.mjs")}; if (process.env.LOAD_IDS) s.requireCloud(); ${code}`], {
    encoding: "utf8", timeout: 30_000, env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, ...IDS, ...env },
  });
  return r.stdout + r.stderr;
};
const show = `const l = await acquireRunLock({ page: "p", allowUnlocked: process.env.ALLOW === "1" }); console.log(JSON.stringify({ acquired: l.acquired, open: !!l.open, holder: l.holder, page: l.page, host: l.host, reason: l.reason, release: typeof l.release })); if (l.release) await l.release();`;
try {
  check("the lock asked for before the Cloud settings are loaded: refused, saying there is no lock host", () => {
    const l = JSON.parse(run(show, {}));
    assert.equal(l.acquired, false); assert.equal(l.open, true); assert.match(l.reason, /no lock host/);
  });
  check("the lock host cannot be reached: refused, naming the host and the reason", () => {
    const l = JSON.parse(run(show, { LOAD_IDS: "1", PSQL_MODE: "down" }));
    assert.equal(l.acquired, false); assert.equal(l.open, true); assert.equal(l.host, "awsaws0001"); assert.match(l.reason, /Connection refused/);
  });
  check("…and with allowUnlocked the run goes ahead, marked open, with nothing to release", () => {
    const l = JSON.parse(run(show, { LOAD_IDS: "1", PSQL_MODE: "down", ALLOW: "1" }));
    assert.equal(l.acquired, true); assert.equal(l.open, true); assert.equal(l.release, "undefined"); assert.match(l.reason, /Connection refused/);
  });
  check("another run holds the project: refused, naming the holder and the page", () => {
    const l = JSON.parse(run(show, { LOAD_IDS: "1", PSQL_MODE: "held" }));
    assert.equal(l.acquired, false); assert.equal(l.open, false); assert.equal(l.holder, "other-machine:4242"); assert.equal(l.page, "security/members");
  });
  check("control: the row is ours, the lock is taken, and release is a function", () => {
    const l = JSON.parse(run(show, { LOAD_IDS: "1" }));
    assert.equal(l.acquired, true); assert.equal(l.open, false); assert.equal(l.release, "function");
  });
} finally {
  rmSync(bin, { recursive: true, force: true });
}

console.log(failed ? `\n${failed} check(s) failed` : "\nall checks passed");
process.exit(failed ? 1 : 0);
