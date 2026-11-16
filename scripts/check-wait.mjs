#!/usr/bin/env node
// Checks `wait up to Ns for postgres in container `name`` (docs/adr/0011): the grammar, the lint's name
// check, and the probe script's own logic, run here against a fake `docker` so each branch (ready after
// a while, never ready, exited, no such container) is exercised without a box. No AWS.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, chmodSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parsePlan, WAIT_MAX_SECONDS } from "../lib/plan.mjs";
import { guideCommandDrift } from "../lib/fidelity.mjs";
import { waitScript } from "../lib/wait.mjs";

const HDR = "target: self-hosted\nmachine: bare\nos: ubuntu\npath: docker-ha";
const plan = (steps, hdr = HDR) => parsePlan(`<TestPlan>\n${hdr}\n${steps}\n</TestPlan>`).plans[0];
const errs = (p) => p.errors.map((e) => e.detail).join(" | ");
const W = "wait up to 90s for postgres in container `timescaledb`";

let failed = 0;
const check = (name, fn) => {
  try { fn(); console.log(`  ok   ${name}`); } catch (e) { failed++; console.log(`  FAIL ${name}\n       ${String(e.message).split("\n").join("\n       ")}`); }
};

check("control: the verb parses to its limit and container, and a plan with it has no errors", () => {
  const p = plan(`1. ${W}`);
  assert.deepEqual(p.errors, []);
  assert.deepEqual(p.steps[0].actions, [{ action: "wait_postgres", seconds: 90, container: "timescaledb" }]);
});
check("a pure delay, a retry and a name with a space are unparsed, never a wait", () => {
  for (const l of ["wait 15s", "retry the psql step for 60s", "wait up to 9s for postgres in container `a b`", "wait up to 9s for postgres"]) {
    const p = plan(`1. ${l}`);
    assert.deepEqual(p.unparsed, [l], l);
  }
});
check("the limit is required and bounded", () => {
  assert.match(errs(plan("1. wait up to 0s for postgres in container `t`")), /1 to 600/);
  assert.match(errs(plan(`1. wait up to ${WAIT_MAX_SECONDS + 1}s for postgres in container \`t\``)), /1 to 600/);
  assert.deepEqual(plan(`1. wait up to ${WAIT_MAX_SECONDS}s for postgres in container \`t\``).errors, []);
});
check("`wait` needs a bare box", () => {
  assert.match(errs(plan(`1. ${W}`, "target: self-hosted")), /machine: bare/);
});

const PAGE = (name) => `<Tabs>\n<TabItem label="Docker">\n<Tabs>\n<TabItem label="TimescaleDB-HA">\n\`\`\`bash\ndocker run -d --name ${name} -p 5432:5432 timescale/timescaledb-ha:pg18\n\`\`\`\n</TabItem>\n</Tabs>\n</TabItem>\n</Tabs>`;
const RUN = (name) => `1. run command: \`docker run -d --name ${name} -p 5432:5432 timescale/timescaledb-ha:pg18\``;
const waitKinds = (page, steps) => guideCommandDrift(page, plan(steps)).filter((d) => d.kind.startsWith("wait")).map((d) => d.kind);
check("control: a wait on the container the page names is clean, and a wait is not 'command not on page'", () => {
  assert.deepEqual(guideCommandDrift(PAGE("timescaledb"), plan(`${RUN("timescaledb")}\n2. ${W}`)), []);
});
check("a wait on a name the page does not use is a finding, even when the plan's own run uses it", () => {
  assert.deepEqual(waitKinds(PAGE("tsdb"), `${RUN("tsdb")}\n2. ${W}`), ["wait names a container not on the page"]);
});
check("the name must be a whole word on the page: `timescaledb-old` and `mytimescaledb` do not count", () => {
  assert.deepEqual(waitKinds(PAGE("timescaledb-old"), `${RUN("timescaledb-old")}\n2. ${W}`), ["wait names a container not on the page"]);
  assert.deepEqual(waitKinds(PAGE("mytimescaledb"), `${RUN("mytimescaledb")}\n2. ${W}`), ["wait names a container not on the page"]);
});
check("a name that is only on a sibling tab does not count (the reader's path, not the page)", () => {
  const page = PAGE("tsdb").replace("</TabItem>\n</Tabs>\n</TabItem>", "</TabItem>\n<TabItem label=\"Other\">\n```bash\ndocker run -d --name timescaledb x\n```\n</TabItem>\n</Tabs>\n</TabItem>");
  assert.deepEqual(waitKinds(page, `${RUN("tsdb")}\n2. ${W}`), ["wait names a container not on the page"]);
});

// The probe script against a fake docker. STATE is what `inspect` prints (or `gone`), READY_AFTER is the
// number of `exec` calls that fail before one succeeds (-1 never), and every call is logged.
const dir = mkdtempSync(join(tmpdir(), "check-wait-"));
const bin = join(dir, "docker");
writeFileSync(bin, `#!/bin/bash
echo "$@" >> "$FAKE_LOG"
case "$1" in
  inspect) [ "$STATE" = gone ] && exit 1; echo "$STATE";;
  logs) echo "FATAL: the fake container's last words";;
  exec) n=$(grep -c '^exec' "$FAKE_LOG"); [ "$READY_AFTER" -ge 0 ] && [ "$n" -gt "$READY_AFTER" ] && exit 0; exit 2;;
esac
`);
chmodSync(bin, 0o755);
const run = (container, seconds, env) => {
  const log = join(dir, `log-${Math.random().toString(36).slice(2)}`);
  writeFileSync(log, "");
  const t = Date.now();
  const r = spawnSync("bash", ["-c", waitScript(container, seconds)], { env: { PATH: `${dir}:${process.env.PATH}`, FAKE_LOG: log, ...env }, encoding: "utf8", timeout: 20_000 });
  return { code: r.status, out: r.stdout, secs: (Date.now() - t) / 1000, calls: readFileSync(log, "utf8").trim().split("\n").filter(Boolean) };
};

check("control: ready on the first probe is exit 0 with `waited 0s`, and probes TCP in the container", () => {
  const r = run("timescaledb", 5, { STATE: "running", READY_AFTER: "0" });
  assert.equal(r.code, 0);
  assert.match(r.out, /^waited 0s$/m);
  assert.ok(r.calls.includes("exec timescaledb pg_isready -q -h 127.0.0.1 -p 5432"), r.calls.join(" ; "));
});
check("not ready at first, then ready: polls, and reports a wait that is not zero", () => {
  const r = run("timescaledb", 10, { STATE: "running", READY_AFTER: "2" });
  assert.equal(r.code, 0);
  assert.match(r.out, /waited [1-9]\d*s/);
  assert.ok(r.secs >= 2 && r.secs < 8, `took ${r.secs}s`);
});
check("never ready fails after the limit, not before it, with the container's log", () => {
  const r = run("timescaledb", 2, { STATE: "running", READY_AFTER: "-1" });
  assert.equal(r.code, 5);
  assert.ok(r.secs >= 2 && r.secs < 6, `took ${r.secs}s`);
  assert.match(r.out, /not accepting connections after 2s/);
  assert.match(r.out, /last words/);
});
check("an exited container fails at once, long before the limit, with its log", () => {
  const r = run("timescaledb", 60, { STATE: "exited", READY_AFTER: "-1" });
  assert.equal(r.code, 4);
  assert.ok(r.secs < 3, `took ${r.secs}s`);
  assert.match(r.out, /is exited, not running/);
  assert.match(r.out, /last words/);
});
check("a container that does not exist fails at once and says so", () => {
  const r = run("nope", 60, { STATE: "gone", READY_AFTER: "-1" });
  assert.equal(r.code, 3);
  assert.ok(r.secs < 3);
  assert.match(r.out, /no container named nope/);
});
check("the script refuses a name or limit that could carry shell", () => {
  for (const [n, s] of [["a'; rm -rf /; '", 5], ["x y", 5], ["", 5], ["ok", 0], ["ok", 1.5]]) assert.throws(() => waitScript(n, s), /refusing/);
});

console.log(failed ? `\n${failed} check(s) failed` : "\nall checks passed");
process.exit(failed ? 1 : 0);
