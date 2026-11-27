#!/usr/bin/env node
// Checks lib/stop.mjs and the places that read it: an interrupted run stops between steps and goes
// through its own teardown instead of exiting from the signal handler. No AWS, no browser, no CLI: the
// EC2 walker is driven with steps that call nothing, and the polls are asked to wait for things that
// do not exist, which they refuse to do once a stop is requested, before any aws or tiger call.
//
// The Console walker (lib/walk.mjs) has the same check at the top of its step loop and is not covered
// here: it needs a browser. The batch runner's SIGTERM-then-SIGKILL is in scripts/check-batch-resume.mjs.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { stopRequested, stopReason, requestStop, resetStop, throwIfStopped, stoppedLine } from "../lib/stop.mjs";
import { walkEc2Procedure } from "../lib/walk-ec2.mjs";
import { waitForSsmRegistration } from "../lib/ec2.mjs";
import { waitUntilReady } from "../lib/fork.mjs";

let failed = 0;
const check = async (name, fn) => {
  try { await fn(); console.log(`  ok   ${name}`); } catch (e) { failed++; console.log(`  FAIL ${name}\n       ${String(e.message).split("\n").join("\n       ")}`); }
};
// Steps that act on nothing: `noted` is reported as given, so the walker runs end to end without a box.
const proc = { title: "p", steps: [0, 1, 2].map((i) => ({ title: `step ${i + 1}`, actions: [{ action: "noted", did: `did ${i + 1}` }] })) };

console.log("before a stop is requested (the controls)");
await check("nothing is requested, and throwIfStopped is silent", async () => {
  assert.equal(stopRequested(), false);
  assert.equal(stopReason(), null);
  throwIfStopped("anything");
});
await check("the EC2 walker runs every step", async () => {
  const r = await walkEc2Procedure(proc);
  assert.equal(r.verdict, "pass");
  assert.deepEqual(r.actions.map((a) => a.status), ["ok", "ok", "ok"]);
});

console.log("after one");
requestStop("SIGINT");
await check("the request is recorded once; a later one does not overwrite the reason", async () => {
  requestStop("SIGTERM");
  assert.equal(stopRequested(), true);
  assert.equal(stopReason(), "SIGINT");
});
await check("throwIfStopped throws a STOPPED error that names what was being waited for", async () => {
  assert.throws(() => throwIfStopped("waiting for x"), (e) => e.code === "STOPPED" && /SIGINT/.test(e.message) && /waiting for x/.test(e.message));
});
await check("the EC2 walker stops at the first step it reaches, reports it, and the verdict is stopped", async () => {
  const r = await walkEc2Procedure(proc);
  assert.equal(r.verdict, "stopped");
  assert.deepEqual(r.actions, [stoppedLine(0)]);
  assert.match(r.actions[0].did, /interrupted \(SIGINT\)/);
});
await check("a failure recorded before the stop still wins (the verdict rule), and resetStop clears the request", async () => {
  // The walker cannot be stopped mid-walk here: `noted` actions have no await for a signal to land in,
  // and every other action calls SSM or psql. So the ordering rule is checked on the walker's inputs:
  // a step that failed before the stop, then the stop. The rule is the one line at the end of
  // walkEc2Procedure: fail, then blocked, then stopped.
  resetStop();
  assert.equal(stopRequested(), false);
  const failing = { title: "p", steps: [{ title: "s1", actions: [{ action: "noted", did: "x", status: "fail" }] }, { title: "s2", actions: [{ action: "noted", did: "y" }] }] };
  assert.equal((await walkEc2Procedure(failing)).verdict, "fail", "control: the failure alone");
  requestStop("SIGINT");
  const r = await walkEc2Procedure(failing);
  assert.equal(r.verdict, "stopped", "stopped before step 1: no step ran, nothing failed");
  assert.deepEqual(r.actions.map((a) => a.status), ["stopped"]);
});
await check("the SSM registration poll refuses to start, before any aws call: it rejects within a few ms", async () => {
  const t0 = Date.now();
  await assert.rejects(waitForSsmRegistration("i-does-not-exist", { timeoutMs: 60_000 }), (e) => e.code === "STOPPED");
  assert.ok(Date.now() - t0 < 500, "took long enough to have called aws");
});
await check("the service readiness poll returns not-ready at once (no tiger call is made)", async () => {
  const t0 = Date.now();
  const r = await waitUntilReady("does-not-exist", { timeoutMs: 60_000 });
  assert.equal(r.ok, false);
  assert.ok(Date.now() - t0 < 2000, "did not return promptly");
});

console.log("the handler, in a process of its own");
await check("the first signal only records the request; the second prints what is left and exits 130", async () => {
  const script = `
    import { installStopHandler, stopRequested, stopReason } from ${JSON.stringify(fileURLToPath(new URL("../lib/stop.mjs", import.meta.url)))};
    installStopHandler({ onFirst: (s) => console.log("first:" + s), leftovers: () => ["fork f-1: tiger service delete f-1 --confirm"] });
    process.kill(process.pid, "SIGINT");
    // a GitHub Actions cancel: SIGTERM after the SIGINT. Must not quit.
    setTimeout(() => { console.log("after SIGINT, requested=" + stopRequested()); process.kill(process.pid, "SIGTERM"); }, 200);
    setTimeout(() => { console.log("after SIGTERM, still running, reason=" + stopReason()); process.kill(process.pid, "SIGHUP"); }, 400);
    setTimeout(() => { console.log("after SIGHUP, still running"); process.kill(process.pid, "SIGINT"); }, 600);
    setTimeout(() => { console.log("not exited"); process.exit(0); }, 3000);
  `;
  const r = spawnSync(process.execPath, ["--input-type=module", "-e", script], { encoding: "utf8", timeout: 10_000 });
  assert.equal(r.status, 130, r.stdout + r.stderr);
  assert.match(r.stdout, /first:SIGINT/);
  assert.match(r.stdout, /after SIGINT, requested=true/);
  assert.match(r.stdout, /after SIGTERM, still running, reason=SIGINT/);
  assert.match(r.stdout, /after SIGHUP, still running/);
  assert.match(r.stderr, /SIGINT again: quitting without cleanup/);
  assert.match(r.stderr, /tiger service delete f-1 --confirm/);
  assert.doesNotMatch(r.stdout, /not exited/);
});
await check("a second Ctrl-C with an onSecond that returns nothing (a run with no lock to release) still exits 130", async () => {
  const script = `
    import { installStopHandler } from ${JSON.stringify(fileURLToPath(new URL("../lib/stop.mjs", import.meta.url)))};
    installStopHandler({ onSecond: () => undefined });
    process.kill(process.pid, "SIGINT");
    setTimeout(() => process.kill(process.pid, "SIGINT"), 200);
    setTimeout(() => { console.log("not exited"); process.exit(0); }, 3000);
  `;
  const r = spawnSync(process.execPath, ["--input-type=module", "-e", script], { encoding: "utf8", timeout: 10_000 });
  assert.equal(r.status, 130, r.stdout + r.stderr);
  assert.doesNotMatch(r.stderr, /TypeError/);
});
await check("a first SIGTERM or SIGHUP is recorded like a Ctrl-C", async () => {
  for (const sig of ["SIGTERM", "SIGHUP"]) {
    const script = `
      import { installStopHandler, stopReason } from ${JSON.stringify(fileURLToPath(new URL("../lib/stop.mjs", import.meta.url)))};
      installStopHandler();
      process.kill(process.pid, "${sig}");
      setTimeout(() => { console.log("reason=" + stopReason()); process.exit(0); }, 200);
    `;
    const r = spawnSync(process.execPath, ["--input-type=module", "-e", script], { encoding: "utf8", timeout: 10_000 });
    assert.equal(r.status, 0, sig + ": " + r.stdout + r.stderr);
    assert.match(r.stdout, new RegExp(`reason=${sig}`));
  }
});

console.log(failed ? `\n${failed} check(s) failed` : "\nall checks passed");
process.exit(failed ? 1 : 0);
