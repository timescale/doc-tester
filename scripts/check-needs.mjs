#!/usr/bin/env node
// Checks `needs:` (docs/adr/0011): the grammar in lib/plan.mjs, and that the harness has an installer for
// every distro a token claims to be provided on. No AWS: the installers are only looked at, not run.
import assert from "node:assert/strict";
import { parsePlan, NEEDS, OSES } from "../lib/plan.mjs";
import { INSTALLERS } from "../lib/prerequisites.mjs";

const plan = (hdr, tail = "1. run command: `true`") => parsePlan(`<TestPlan>\n${hdr}\n${tail}\n</TestPlan>`).plans[0];
const errs = (p) => p.errors.map((e) => e.detail).join(" | ");
const BARE = "target: self-hosted\nmachine: bare\nos: ubuntu";

let failed = 0;
const check = (name, fn) => {
  try { fn(); console.log(`  ok   ${name}`); } catch (e) { failed++; console.log(`  FAIL ${name}\n       ${String(e.message).split("\n").join("\n       ")}`); }
};

check("control: a bare plan with needs parses, in the order written, and a plan without it has none", () => {
  const p = plan(`${BARE}\nneeds: psql, docker`);
  assert.deepEqual(p.errors, []);
  assert.deepEqual(p.needs, ["psql", "docker"]);
  assert.deepEqual(plan(BARE).needs, []);
});
check("`needs:` is a parse error without a bare box, with an unknown token, twice, listing a token twice, empty, or after step 1", () => {
  assert.match(errs(plan("target: self-hosted\nneeds: docker")), /machine: bare/);
  assert.match(errs(plan(`${BARE}\nneeds: dockr`)), /not a prerequisite.*docker, psql/);
  assert.match(errs(plan(`${BARE}\nneeds: docker\nneeds: psql`)), /more than one `needs:`/);
  assert.match(errs(plan(`${BARE}\nneeds: docker, docker`)), /lists docker twice/);
  assert.match(errs(plan(`${BARE}\nneeds: ,`)), /names no prerequisite/);
  // A bare `needs:` with nothing after it is not a header line (as with `target:`), so it provides nothing and the plan's first `docker` step fails loudly instead.
  assert.deepEqual(plan(`${BARE}\nneeds:`).needs, []);
  assert.match(errs(plan(BARE, "1. run command: `true`\nneeds: docker")), /before step 1/);
});
check("a prerequisite the harness cannot provide on that distro is refused at parse time, not at provisioning", () => {
  assert.match(errs(plan("target: self-hosted\nmachine: bare\nos: debian\nneeds: docker")), /not provided on debian.*ubuntu/);
});
check("every distro a token claims has an installer and a probe, and every installer is claimed", () => {
  for (const [need, oses] of Object.entries(NEEDS)) {
    for (const os of oses) {
      assert.ok(OSES.includes(os), `${need} claims unknown distro ${os}`);
      const row = INSTALLERS[need]?.[os];
      assert.ok(row && typeof row.install === "function" && row.probe, `${need} on ${os} has no installer`);
      assert.match(row.install("someuser"), /^set -eu/, `${need} on ${os}: the installer must stop on the first error`);
    }
  }
  for (const [need, byOs] of Object.entries(INSTALLERS)) for (const os of Object.keys(byOs)) assert.ok(NEEDS[need]?.includes(os), `${need} on ${os} has an installer nothing claims`);
});
check("Docker's installer makes it usable by the default user without sudo", () => {
  assert.match(INSTALLERS.docker.ubuntu.install("ubuntu"), /usermod -aG docker ubuntu/);
  assert.match(INSTALLERS.docker.ubuntu.probe, /Server\.Version/); // the SERVER version: it fails if the daemon is unreachable
});

console.log(failed ? `\n${failed} check(s) failed` : "\nall checks passed");
process.exit(failed ? 1 : 0);
