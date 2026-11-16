#!/usr/bin/env node
// Checks the pod forms of `wait` (docs/adr/0011, step 4b): ``wait up to Ns for postgres in pod `name` `` and
// ``wait up to Ns for pod `name` ready``, the second for a pod that runs no postgres (the guide's
// `test-pod`, which runs `sleep infinity`). The grammar, the lint's name rule, and the probe scripts' own
// logic, run here against a fake `kubectl` so each branch (ready after a while, never ready, still pulling
// its image, crashed, gone) is exercised without a box. No AWS. The container form is in check-wait.mjs.
//
// Why a probe through `kubectl exec` and not `kubectl wait --for=condition=ready`: on k3s a pod with no
// readiness probe is Ready the moment its container starts, with initdb still running (observed, four runs).
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, chmodSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parsePlan, WAIT_MAX_SECONDS } from "../lib/plan.mjs";
import { guideCommandDrift } from "../lib/fidelity.mjs";
import { waitPodScript, waitPodReadyScript } from "../lib/wait.mjs";

const HDR = "target: self-hosted\nmachine: bare\nos: ubuntu\npath: kubernetes";
const plan = (steps, hdr = HDR) => parsePlan(`<TestPlan>\n${hdr}\n${steps}\n</TestPlan>`).plans[0];
const errs = (p) => p.errors.map((e) => e.detail).join(" | ");
const W = "wait up to 300s for postgres in pod `timescaledb-0`";

let failed = 0;
const check = (name, fn) => {
  try { fn(); console.log(`  ok   ${name}`); } catch (e) { failed++; console.log(`  FAIL ${name}\n       ${String(e.message).split("\n").join("\n       ")}`); }
};

console.log("the grammar");
check("control: the verb parses to its limit and pod, and a plan with it has no errors", () => {
  const p = plan(`1. ${W}`);
  assert.deepEqual(p.errors, []);
  assert.deepEqual(p.steps[0].actions, [{ action: "wait_postgres", seconds: 300, pod: "timescaledb-0" }]);
});
check("the container form still parses to a container (control)", () => {
  assert.deepEqual(plan("1. wait up to 90s for postgres in container `timescaledb`").steps[0].actions, [{ action: "wait_postgres", seconds: 90, container: "timescaledb" }]);
});
check("`pod ... ready` is a Ready wait, a different action from the postgres wait, and only for a pod", () => {
  assert.deepEqual(plan("1. wait up to 120s for pod `test-pod` ready").steps[0].actions, [{ action: "wait_pod_ready", seconds: 120, pod: "test-pod" }]);
  assert.deepEqual(plan("1. wait up to 120s for pod `test-pod` ready").errors, []);
  assert.notEqual(plan("1. wait up to 120s for pod `test-pod` ready").steps[0].actions[0].action, plan(`1. ${W}`).steps[0].actions[0].action);
});
check("the near-misses are unparsed, never a wait", () => {
  for (const l of ["wait up to 300s for pod `timescaledb-0`", "wait up to 9s for postgres in pod `a b`", "wait up to 9s for postgres in pod `Timescaledb-0`", "wait up to 9s for postgres in pod", "wait up to 9s for container `x` ready", "wait up to 9s for pod `A b` ready", "wait for pod `x` ready"]) {
    assert.deepEqual(plan(`1. ${l}`).unparsed, [l], l);
  }
});check("the limit is required and bounded, and the verb needs a bare box, as for a container", () => {
  assert.match(errs(plan("1. wait up to 0s for postgres in pod `t-0`")), /1 to 600/);
  assert.match(errs(plan(`1. wait up to ${WAIT_MAX_SECONDS + 1}s for postgres in pod \`t-0\``)), /1 to 600/);
  assert.deepEqual(plan(`1. wait up to ${WAIT_MAX_SECONDS}s for postgres in pod \`t-0\``).errors, []);
  assert.match(errs(plan(`1. ${W}`, "target: self-hosted")), /machine: bare/);
  assert.match(errs(plan("1. wait up to 0s for pod `t-0` ready")), /1 to 600/);
  assert.match(errs(plan(`1. wait up to ${WAIT_MAX_SECONDS + 1}s for pod \`t-0\` ready`)), /1 to 600/);
  assert.match(errs(plan("1. wait up to 9s for pod `t-0` ready", "target: self-hosted")), /machine: bare/);
});

console.log("the lint's name rule: the page names the StatefulSet, never the pod");
const PAGE = (set) => `<Tabs>\n<TabItem label="Kubernetes">\n\`\`\`shell\nkubectl create namespace tigerdata\n\`\`\`\n\`\`\`yaml\nkubectl apply -f - <<EOF\napiVersion: apps/v1\nkind: StatefulSet\nmetadata:\n  name: ${set}\nEOF\n\`\`\`\n</TabItem>\n</Tabs>\n`;
const waitKinds = (page, wait) => guideCommandDrift(page, plan(`1. run command: \`kubectl create namespace tigerdata\`\n2. ${wait}`)).filter((d) => d.kind.startsWith("wait")).map((d) => d.kind);
check("control: `NAME-N` where NAME is on the page is clean, and a wait is not 'command not on page'", () => {
  assert.deepEqual(waitKinds(PAGE("timescaledb"), W), []);
});
check("a pod whose NAME the page does not use is a finding", () => {
  assert.deepEqual(waitKinds(PAGE("tsdb"), W), ["wait names a pod not on the page"]);
});
check("NAME must be a whole word: `timescaledbx` and `old-timescaledb` do not make `timescaledb` appear", () => {
  assert.deepEqual(waitKinds(PAGE("timescaledbx"), W), ["wait names a pod not on the page"]);
  assert.deepEqual(waitKinds(PAGE("old-timescaledb"), W), ["wait names a pod not on the page"]);
});
check("a pod name with no ordinal must itself be on the page", () => {
  assert.deepEqual(waitKinds(PAGE("timescaledb"), "wait up to 60s for postgres in pod `test-pod`"), ["wait names a pod not on the page"]);
  const withPod = PAGE("timescaledb").replace("kubectl create namespace tigerdata", "kubectl run test-pod --image=postgres");
  assert.deepEqual(guideCommandDrift(withPod, plan("1. run command: `kubectl run test-pod --image=postgres`\n2. wait up to 60s for postgres in pod `test-pod`")).filter((d) => d.kind.startsWith("wait")), []);
});
check("the Ready form is held to the same name rule", () => {
  const onPage = PAGE("timescaledb").replace("kubectl create namespace tigerdata", "kubectl run test-pod --image=postgres");
  assert.deepEqual(guideCommandDrift(onPage, plan("1. run command: `kubectl run test-pod --image=postgres`\n2. wait up to 60s for pod `test-pod` ready")).filter((d) => d.kind.startsWith("wait")), []);
  assert.deepEqual(waitKinds(PAGE("timescaledb"), "wait up to 60s for pod `test-pod` ready"), ["wait names a pod not on the page"]);
  assert.deepEqual(waitKinds(PAGE("tsdb"), "wait up to 60s for pod `timescaledb-0` ready"), ["wait names a pod not on the page"]);
});
check("known ceiling, pinned: the ordinal is not checked against `replicas`, so `timescaledb-7` passes the lint", () => {
  assert.deepEqual(waitKinds(PAGE("timescaledb"), "wait up to 300s for postgres in pod `timescaledb-7`"), []);
});

console.log("the probe script against a fake kubectl");
// get pod prints PHASE|TERMINATED|WAITING (or fails when GONE), and the Ready condition once READY_AFTER polls
// have passed (-1 never); exec fails READY_AFTER times before one succeeds (-1 never); describe and logs print a marker so the failure tail can be asserted.
const dir = mkdtempSync(join(tmpdir(), "check-wait-pod-"));
writeFileSync(join(dir, "kubectl"), `#!/bin/bash
echo "$@" >> "$FAKE_LOG"
case "$1" in
  get) [ -n "$GONE" ] && { echo 'Error from server (NotFound): pods not found' >&2; exit 1; }
       case "$*" in
         *conditions*) n=$(grep -c 'conditions' "$FAKE_LOG"); [ "\${READY_AFTER:--1}" -ge 0 ] && [ "$n" -gt "$READY_AFTER" ] && echo True || echo False;;
         *) echo "$PHASE|$TERMINATED|$WAITING";;
       esac;;
  describe) echo "Events: the fake pod's last events";;
  logs) echo "FATAL: the fake pod's last words";;
  exec) n=$(grep -c '^exec' "$FAKE_LOG"); [ "$READY_AFTER" -ge 0 ] && [ "$n" -gt "$READY_AFTER" ] && exit 0; exit 2;;
esac
`);
chmodSync(join(dir, "kubectl"), 0o755);
const run = (pod, seconds, env) => {
  const log = join(dir, `log-${Math.random().toString(36).slice(2)}`);
  writeFileSync(log, "");
  const t = Date.now();
  const r = spawnSync("bash", ["-c", waitPodScript(pod, seconds)], { env: { PATH: `${dir}:${process.env.PATH}`, FAKE_LOG: log, PHASE: "Running", TERMINATED: "", WAITING: "", ...env }, encoding: "utf8", timeout: 20_000 });
  return { code: r.status, out: r.stdout, secs: (Date.now() - t) / 1000, calls: readFileSync(log, "utf8").trim().split("\n").filter(Boolean) };
};

check("control: ready on the first probe is exit 0 with `waited 0s`, probing TCP inside the pod", () => {
  const r = run("timescaledb-0", 5, { READY_AFTER: "0" });
  assert.equal(r.code, 0);
  assert.match(r.out, /^waited 0s$/m);
  assert.ok(r.calls.includes("exec timescaledb-0 -- pg_isready -q -h 127.0.0.1 -p 5432"), r.calls.join(" ; "));
});
check("not ready at first, then ready: polls, and reports a wait that is not zero", () => {
  const r = run("timescaledb-0", 10, { READY_AFTER: "2" });
  assert.equal(r.code, 0);
  assert.match(r.out, /waited [1-9]\d*s/);
  assert.ok(r.secs >= 2 && r.secs < 8, `took ${r.secs}s`);
});
check("never ready fails after the limit, not before it, with the pod's events and log", () => {
  const r = run("timescaledb-0", 2, { READY_AFTER: "-1" });
  assert.equal(r.code, 5);
  assert.ok(r.secs >= 2 && r.secs < 6, `took ${r.secs}s`);
  assert.match(r.out, /not accepting connections after 2s/);
  assert.match(r.out, /last events/);
  assert.match(r.out, /last words/);
});
check("a pod still pulling its image (Pending, the container waiting) is polled to the limit, not failed early", () => {
  const r = run("timescaledb-0", 2, { PHASE: "Pending", WAITING: "ContainerCreating", READY_AFTER: "-1" });
  assert.equal(r.code, 5);
  assert.ok(r.secs >= 2, `gave up after ${r.secs}s`);
});
check("a terminated container fails at once, long before the limit, with the pod's log", () => {
  const r = run("timescaledb-0", 60, { PHASE: "Running", TERMINATED: "Error", READY_AFTER: "-1" });
  assert.equal(r.code, 4);
  assert.ok(r.secs < 3, `took ${r.secs}s`);
  assert.match(r.out, /Error/);
  assert.match(r.out, /last words/);
});
check("CrashLoopBackOff, a Failed pod and a Succeeded pod each fail at once", () => {
  for (const env of [{ WAITING: "CrashLoopBackOff" }, { PHASE: "Failed" }, { PHASE: "Succeeded" }]) {
    const r = run("timescaledb-0", 60, { READY_AFTER: "-1", ...env });
    assert.equal(r.code, 4, JSON.stringify(env));
    assert.ok(r.secs < 3, `${JSON.stringify(env)} took ${r.secs}s`);
  }
});
check("a pod that does not exist fails at once and says so", () => {
  const r = run("nope-0", 60, { GONE: "1", READY_AFTER: "-1" });
  assert.equal(r.code, 3);
  assert.ok(r.secs < 3);
  assert.match(r.out, /no pod named nope-0/);
});
check("the script refuses a name or limit that could carry shell", () => {
  for (const [n, s] of [["a'; rm -rf /; '", 5], ["x y", 5], ["", 5], ["Upper-0", 5], ["ok-0", 0], ["ok-0", 1.5]]) assert.throws(() => waitPodScript(n, s), /refusing/);
});

const runReady = (pod, seconds, env) => {
  const log = join(dir, `log-${Math.random().toString(36).slice(2)}`);
  writeFileSync(log, "");
  const t = Date.now();
  const r = spawnSync("bash", ["-c", waitPodReadyScript(pod, seconds)], { env: { PATH: `${dir}:${process.env.PATH}`, FAKE_LOG: log, PHASE: "Running", TERMINATED: "", WAITING: "", ...env }, encoding: "utf8", timeout: 20_000 });
  return { code: r.status, out: r.stdout, secs: (Date.now() - t) / 1000, calls: readFileSync(log, "utf8").trim().split("\n").filter(Boolean) };
};
console.log("the Ready form's script against the same fake");
check("control: Ready on the first look is exit 0 with `waited 0s`, and it never probes postgres", () => {
  const r = runReady("test-pod", 5, { READY_AFTER: "0" });
  assert.equal(r.code, 0);
  assert.match(r.out, /^waited 0s$/m);
  assert.ok(!r.calls.some((c) => c.startsWith("exec")), `a Ready wait must not exec into the pod: ${r.calls.join(" ; ")}`);
});
check("a pod that is Ready only after a while is polled, and the wait is reported", () => {
  const r = runReady("test-pod", 10, { READY_AFTER: "2" });
  assert.equal(r.code, 0);
  assert.match(r.out, /waited [1-9]\d*s/);
  assert.ok(r.secs >= 2 && r.secs < 8, `took ${r.secs}s`);
});
check("never Ready fails after the limit, not before it, with the pod's events and log", () => {
  const r = runReady("test-pod", 2, { READY_AFTER: "-1" });
  assert.equal(r.code, 5);
  assert.ok(r.secs >= 2 && r.secs < 6, `took ${r.secs}s`);
  assert.match(r.out, /was not Ready after 2s/);
  assert.match(r.out, /last events/);
  assert.match(r.out, /last words/);
});
check("a pod still pulling its image is polled to the limit, not failed early", () => {
  const r = runReady("test-pod", 2, { PHASE: "Pending", WAITING: "ContainerCreating", READY_AFTER: "-1" });
  assert.equal(r.code, 5);
  assert.ok(r.secs >= 2, `gave up after ${r.secs}s`);
});
check("a terminated container, CrashLoopBackOff, a Failed pod and a missing pod each fail at once", () => {
  for (const [env, code] of [[{ TERMINATED: "Error" }, 4], [{ WAITING: "CrashLoopBackOff" }, 4], [{ PHASE: "Failed" }, 4], [{ GONE: "1" }, 3]]) {
    const r = runReady("test-pod", 60, { READY_AFTER: "-1", ...env });
    assert.equal(r.code, code, JSON.stringify(env));
    assert.ok(r.secs < 3, `${JSON.stringify(env)} took ${r.secs}s`);
  }
});
check("the Ready script refuses a name or limit that could carry shell", () => {
  for (const [n, s] of [["a'; rm -rf /; '", 5], ["x y", 5], ["", 5], ["Upper", 5], ["ok", 0], ["ok", 1.5]]) assert.throws(() => waitPodReadyScript(n, s), /refusing/);
});

console.log(failed ? `\n${failed} check(s) failed` : "\nall checks passed");
process.exit(failed ? 1 : 0);
