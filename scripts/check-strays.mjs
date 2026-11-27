#!/usr/bin/env node
// Checks the decision shared by the walk's capture of a service it created and the end-of-run sweep
// (lib/fork.mjs partitionArrivals): a service that appeared during the run is this run's only when it
// carries one of the exact names the run issued; one that appeared under any other name is somebody's
// and is listed, never deleted (EDU-1068). Pure, no CLI.
import assert from "node:assert/strict";
import { runNamePrefix, createdServiceName, ownedByRun, partitionArrivals } from "../lib/fork.mjs";

let failed = 0;
const check = (name, fn) => {
  try { fn(); console.log(`  ok   ${name}`); } catch (e) { failed++; console.log(`  FAIL ${name}\n       ${String(e.message).split("\n").join("\n       ")}`); }
};
const svc = (id, name) => ({ service_id: id, name });

check("the names a run issues: the fork, then one per created service, counted", () => {
  assert.equal(runNamePrefix("create-service"), "doctest-create-service");
  assert.equal(createdServiceName("create-service", 1), "doctest-create-service-created");
  assert.equal(createdServiceName("create-service", 2), "doctest-create-service-created-2");
});
const issued = new Set(["doctest-create-service", "doctest-create-service-created", "doctest-create-service-created-2"]);
check("ownership is by exact issued name", () => {
  for (const n of issued) assert.equal(ownedByRun(svc("a", n), issued), true, n);
  // Another page's run, the wizard's default, a person's name, a name that merely extends an issued
  // one, no name, no service: none of these are the run's.
  for (const name of ["doctest-other-page", "doctest-create-service-created-3", "doctest-create-service-createdX", "db-58210", "my-service", "", undefined]) assert.equal(ownedByRun(svc("a", name), issued), false, String(name));
  assert.equal(ownedByRun(null, issued), false);
  assert.equal(ownedByRun(svc("a", "doctest-create-service"), ["doctest-create-service"]), true, "an array of names works too");
});
check("two pages that share a last path segment do not own each other's services", () => {
  // `insert` issues `doctest-insert-created`; a service named for `doctest-insert-data-created` is not its.
  assert.equal(ownedByRun(svc("a", "doctest-insert-data-created"), [createdServiceName("insert", 1)]), false);
});
check("the sweep: what appeared under an issued name is mine, the rest is others, and nothing already there or excluded is either", () => {
  const before = new Set(["standing1", "standing2", "old-leftover"]);
  const after = [
    svc("standing1", "tiger-docs-aws"), svc("standing2", "tiger-docs-azure"), svc("old-leftover", "db-11111"),
    svc("fork1", "doctest-create-service"), svc("made1", "doctest-create-service-created"), svc("late1", "doctest-create-service-created-2"),
    svc("person1", "db-58210"), svc("person2", "analytics"), { id: "noid-style", name: "doctest-create-service" },
  ];
  const r = partitionArrivals(before, after, issued, { exclude: ["fork1", "made1", undefined, null] });
  assert.deepEqual(r.mine.map((s) => s.service_id || s.id), ["late1", "noid-style"]);
  assert.deepEqual(r.others.map((s) => s.service_id), ["person1", "person2"]);
});
check("the walk's capture: one name, the service that carries it is mine, an arrival under another name is others", () => {
  const r = partitionArrivals(new Set(["s1"]), [svc("s1", "x"), svc("new1", "doctest-p-created"), svc("new2", "db-1")], ["doctest-p-created"]);
  assert.deepEqual(r.mine.map((s) => s.service_id), ["new1"]);
  assert.deepEqual(r.others.map((s) => s.service_id), ["new2"]);
});
check("control: nothing appeared, nothing to do", () => {
  assert.deepEqual(partitionArrivals(new Set(["a"]), [svc("a", "x")], issued), { mine: [], others: [] });
});
check("an entry with no id at all is ignored, not deleted", () => {
  assert.deepEqual(partitionArrivals(new Set(), [{ name: "doctest-create-service" }], issued), { mine: [], others: [] });
});

console.log(failed ? `\n${failed} check(s) failed` : "\nall checks passed");
process.exit(failed ? 1 : 0);
