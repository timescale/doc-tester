#!/usr/bin/env node
// Checks savedRunSince (lib/report.mjs), which keeps test-batch from grading a page with the previous
// run's last-run.json (#114). Temp files only: no docs checkout, no AWS.
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { savedRunSince } from "../lib/report.mjs";

const dir = mkdtempSync(join(tmpdir(), "saved-run-"));
const file = join(dir, "last-run.json");
const write = (ageMs) => {
  writeFileSync(file, JSON.stringify({ meta: { url: "u" }, result: { testable: true, procedures: [] } }));
  const t = (Date.now() - ageMs) / 1000;
  utimesSync(file, t, t);
};
const spawnedAt = Date.now() - 60_000; // the child started a minute ago

let failed = 0;
const check = (name, fn) => {
  try { fn(); console.log(`  ok   ${name}`); } catch (e) { failed++; console.log(`  FAIL ${name}\n       ${String(e.message).split("\n").join("\n       ")}`); }
};

check("control: a file the child wrote after it started is read", () => {
  write(10_000);
  assert.equal(savedRunSince(spawnedAt, file)?.meta.url, "u");
});
check("a file from before the child started is the previous run's, and is ignored", () => {
  write(5 * 60_000);
  assert.equal(savedRunSince(spawnedAt, file), null);
});
check("no file is null, not a throw", () => assert.equal(savedRunSince(spawnedAt, join(dir, "missing.json")), null));
check("an unreadable file is null, not a throw", () => {
  writeFileSync(file, "{not json");
  assert.equal(savedRunSince(spawnedAt, file), null);
});

console.log(failed ? `\n${failed} check(s) failed` : "\nall checks passed");
process.exit(failed ? 1 : 0);
