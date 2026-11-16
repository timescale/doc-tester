#!/usr/bin/env node
// Checks runUnits (lib/plan.mjs), the one place test-page and test-batch decide what a run walks, so a
// batch's --dry-run and the children it spawns cannot disagree. No docs checkout, no AWS.
import assert from "node:assert/strict";
import { parsePlan, runUnits } from "../lib/plan.mjs";

const bare = (os) => `<TestPlan>\ntarget: self-hosted\nmachine: bare\nos: ${os}\n1. run command: \`true\`\n</TestPlan>`;
const cloud = "<TestPlan>\n1. click `Save`\n</TestPlan>";
const both = parsePlan([bare("ubuntu"), bare("debian"), bare("arch"), cloud].join("\n"));
const cloudOnly = parsePlan(cloud);
const names = (u) => u.map((x) => [x.target, x.os].filter(Boolean).join(":"));

let failed = 0;
const check = (name, fn) => {
  try { fn(); console.log(`  ok   ${name}`); } catch (e) { failed++; console.log(`  FAIL ${name}\n       ${String(e.message).split("\n").join("\n       ")}`); }
};

check("control: no filter is one unit per (target, block)", () =>
  assert.deepEqual(names(runUnits(both).units), ["cloud", "self-hosted:ubuntu", "self-hosted:debian", "self-hosted:arch"]));
check("--os keeps the named distros, and drops the cloud unit with them", () =>
  assert.deepEqual(names(runUnits(both, null, ["debian", "arch"]).units), ["self-hosted:debian", "self-hosted:arch"]));
check("a unit --os leaves out is still in allUnits, so it can be reported as not run", () => {
  const r = runUnits(both, null, ["debian"]);
  assert.equal(r.allUnits.length, 4);
  assert.equal(r.units.length, 1);
});
check("--products narrows first, --os then narrows what is left", () =>
  assert.deepEqual(names(runUnits(both, ["self-hosted"], ["ubuntu"]).units), ["self-hosted:ubuntu"]));
check("a page with no block for the distro has no units", () => {
  assert.deepEqual(runUnits(both, null, ["fedora"]).units, []);
  assert.deepEqual(runUnits(cloudOnly, null, ["ubuntu"]).units, []);
});

console.log(failed ? `\n${failed} check(s) failed` : "\nall checks passed");
process.exit(failed ? 1 : 0);
