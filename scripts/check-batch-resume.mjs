#!/usr/bin/env node
// Checks `test-batch --resume`: what counts as done, the flags guard, a unique batch
// directory, and the exit code. The decisions are pure functions in lib/batch-resume.mjs, tested directly;
// then the real script runs against a stub child (DOCTEST_PAGE_SCRIPT) in a throwaway batch root
// (DOCTEST_BATCH_ROOT), so no browser, no box and none of the real batch history is touched. No AWS.
//
// The rule: only a verdict the tool actually reached counts as done (pass, fail, blocked, stopped, and
// skipped, a saved "nothing testable"). A page that timed out, crashed, was refused or ended with no saved
// result has no verdict, and `--resume` runs it again.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync, readdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isSettled, splitResume, flagsMismatch, uniqueBatchName, batchExitCode } from "../lib/batch-resume.mjs";

let failed = 0;
const check = (name, fn) => {
  try { fn(); console.log(`  ok   ${name}`); } catch (e) { failed++; console.log(`  FAIL ${name}\n       ${String(e.message).split("\n").join("\n       ")}`); }
};

console.log("the decisions");
check("a verdict the tool reached is settled; one it never got is not", () => {
  for (const v of ["pass", "fail", "blocked", "stopped", "skipped"]) assert.equal(isSettled(v), true, v);
  for (const v of ["timeout", "crashed", "refused", "unknown", undefined, null, ""]) assert.equal(isSettled(v), false, String(v));
});

const page = (slug) => ({ url: `https://x/docs/${slug}`, title: slug });
const done = (o) => Object.fromEntries(Object.entries(o).map(([slug, verdict]) => [`https://x/docs/${slug}`, { verdict }]));
check("resume skips settled pages and runs the rest again, saying which and why", () => {
  const runnable = ["a", "b", "c", "d", "e"].map(page);
  const r = splitResume(runnable, done({ a: "pass", b: "fail", c: "timeout", d: "crashed" }));
  assert.deepEqual(r.skip.map((p) => p.title), ["a", "b"]);
  assert.deepEqual(r.run.map((p) => p.title), ["c", "d", "e"]); // c and d again, e never run
  assert.deepEqual(r.again.map((x) => `${x.page.title}:${x.verdict}`), ["c:timeout", "d:crashed"]);
});
check("a page with no prior entry runs, and is not reported as run again", () => {
  const r = splitResume([page("a")], {});
  assert.deepEqual(r.run.map((p) => p.title), ["a"]);
  assert.deepEqual(r.again, []);
});

check("flags: the same --products and --os match, in any order; a different one is named", () => {
  assert.equal(flagsMismatch({ products: ["cloud", "self-hosted"], os: null }, { products: ["self-hosted", "cloud"], os: null }), null);
  assert.equal(flagsMismatch({ products: null, os: null }, { products: null, os: null }), null);
  assert.match(flagsMismatch({ products: ["cloud"], os: null }, { products: ["self-hosted"], os: null }), /--products/);
  assert.match(flagsMismatch({ products: null, os: ["ubuntu"] }, { products: null, os: ["debian"] }), /--os/);
  assert.match(flagsMismatch({ products: null, os: null }, { products: null, os: ["ubuntu"] }), /--os/);
});
check("flags: a batch from before flags were recorded cannot be compared, so it is allowed", () => {
  assert.equal(flagsMismatch(undefined, { products: ["cloud"], os: null }), null);
});

check("a batch directory name never collides with one that exists, even in the same second", () => {
  assert.equal(uniqueBatchName([], "batch-2026-10-20T12-00-00"), "batch-2026-10-20T12-00-00");
  assert.equal(uniqueBatchName(["batch-2026-10-20T12-00-00"], "batch-2026-10-20T12-00-00"), "batch-2026-10-20T12-00-00-2");
  assert.equal(uniqueBatchName(["batch-2026-10-20T12-00-00", "batch-2026-10-20T12-00-00-2"], "batch-2026-10-20T12-00-00"), "batch-2026-10-20T12-00-00-3");
});
check("the most recent batch is still the latest by name, with a suffix after its base", () => {
  const names = ["batch-2026-10-20T12-00-00", "batch-2026-10-20T12-00-00-2", "batch-2026-10-19T09-00-00"].sort().reverse();
  assert.equal(names[0], "batch-2026-10-20T12-00-00-2");
});

check("the exit code is 1 for a failure and for any page with no verdict, 0 when every verdict is a result", () => {
  const ex = (...vs) => batchExitCode(vs.map((verdict) => ({ verdict })));
  assert.equal(ex("pass", "blocked", "stopped", "skipped"), 0);
  assert.equal(ex("pass", "fail"), 1);
  for (const v of ["timeout", "crashed", "refused", "unknown"]) assert.equal(ex("pass", v), 1, v);
});

console.log("the real script against a stub child");
const root = mkdtempSync(join(tmpdir(), "check-batch-resume-"));
const batches = join(root, "batches");
mkdirSync(batches);
const calls = join(root, "calls.log");
const stub = join(root, "stub-page.mjs");
// the child's whole interface: it is given the page URL first, and exits with STUB_EXIT
writeFileSync(stub, `import { appendFileSync } from "node:fs"; appendFileSync(${JSON.stringify(calls)}, process.argv[2] + "\\n"); process.exit(Number(process.env.STUB_EXIT ?? 0));\n`);
const pages = join(root, "pages.txt");
writeFileSync(pages, "self-hosted/kubernetes-dev\nself-hosted/docker-dev\n");
const URL = (slug) => `https://www.tigerdata.com/docs/${slug}`;
const ROOT = join(import.meta.dirname, "..");
const batch = (args, env = {}) => {
  writeFileSync(calls, "");
  const r = spawnSync(process.execPath, [join(ROOT, "scripts", "test-batch.mjs"), "--pages", pages, ...args], {
    cwd: ROOT, encoding: "utf8", timeout: 60_000,
    env: { ...process.env, DOCS_REPO: join(ROOT, "dev-fixtures", "docs-repo"), DOCTEST_BATCH_ROOT: batches, DOCTEST_PAGE_SCRIPT: stub, ...env },
  });
  return { code: r.status, out: r.stdout + r.stderr, ran: readFileSync(calls, "utf8").trim().split("\n").filter(Boolean) };
};
const seed = (name, state) => { mkdirSync(join(batches, name), { recursive: true }); writeFileSync(join(batches, name, "state.json"), JSON.stringify(state)); };
const dirs = () => readdirSync(batches).sort();

check("control: a fresh batch runs every page once", () => {
  const r = batch([]);
  assert.deepEqual(r.ran.sort(), [URL("self-hosted/docker-dev"), URL("self-hosted/kubernetes-dev")].sort(), r.out.slice(-400));
});
check("a resumed batch skips a settled page and runs a timed-out one again", () => {
  seed("batch-9999-01-01T00-00-00", { flags: { products: null, os: null }, done: { [URL("self-hosted/kubernetes-dev")]: { verdict: "pass" }, [URL("self-hosted/docker-dev")]: { verdict: "timeout" } } });
  const r = batch(["--resume"]);
  assert.deepEqual(r.ran, [URL("self-hosted/docker-dev")], r.out.slice(-600));
  assert.match(r.out, /1 already done.*pass/);
  assert.match(r.out, /run again.*timeout.*docker-dev|docker-dev.*timeout/s);
});
check("the same resume, with the settled verdict replaced by a crash, runs both (the control for the one above)", () => {
  seed("batch-9999-01-02T00-00-00", { flags: { products: null, os: null }, done: { [URL("self-hosted/kubernetes-dev")]: { verdict: "crashed" }, [URL("self-hosted/docker-dev")]: { verdict: "refused" } } });
  const r = batch(["--resume"]);
  assert.deepEqual(r.ran.sort(), [URL("self-hosted/docker-dev"), URL("self-hosted/kubernetes-dev")].sort(), r.out.slice(-600));
});
check("resuming with different flags is refused before anything runs, and names the flag", () => {
  seed("batch-9999-01-03T00-00-00", { flags: { products: ["cloud"], os: null }, done: {} });
  const r = batch(["--resume", "--products", "self-hosted"]);
  assert.equal(r.code, 2, r.out.slice(-500));
  assert.match(r.out, /--products/);
  assert.deepEqual(r.ran, []);
});
check("a page that ends with no verdict makes the batch exit 1, though the child exited 0", () => {
  const r = batch([], { STUB_EXIT: "0" });
  assert.equal(r.code, 1, r.out.slice(-400));
});
check("two batches started in the same second get two directories", () => {
  const before = dirs().length;
  // pin the clock: both batches see the same second
  const env = { DOCTEST_BATCH_NOW: "2026-10-20T12:00:00.000Z" };
  batch([], env);
  batch([], env);
  const added = dirs().length - before;
  assert.equal(added, 2, `expected 2 new directories, got ${added}: ${dirs().join(", ")}`);
});
check("a new batch records the flags it was started with", () => {
  batch(["--products", "self-hosted"], { DOCTEST_BATCH_NOW: "2026-10-20T13:00:00.000Z" });
  const dir = dirs().find((d) => d.startsWith("batch-2026-10-20T13-00-00"));
  assert.deepEqual(JSON.parse(readFileSync(join(batches, dir, "state.json"), "utf8")).flags, { products: ["self-hosted"], os: null });
});

console.log(failed ? `\n${failed} check(s) failed` : "\nall checks passed");
process.exit(failed ? 1 : 0);
