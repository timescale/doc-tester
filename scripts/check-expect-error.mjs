#!/usr/bin/env node
// Checks `expect error:` (docs/adr/0012): the grammar, the compiled DO block, and the lint's treatment of
// the statement under test. The block itself was run against a service when the verb was built; this
// checks what a plan compiles to, without a database. No AWS.
import assert from "node:assert/strict";
import { parsePlan } from "../lib/plan.mjs";
import { statementsDriftedFromPage, statementsNotRun } from "../lib/fidelity.mjs";

const plan = (steps) => parsePlan(`<TestPlan>\ntarget: self-hosted\n${steps}\n</TestPlan>`).plans[0];
const act = (steps, n = 1) => plan(steps).steps[n - 1].actions[0];

let failed = 0;
const check = (name, fn) => {
  try { fn(); console.log(`  ok   ${name}`); } catch (e) { failed++; console.log(`  FAIL ${name}\n       ${String(e.message).split("\n").join("\n       ")}`); }
};

check("the plain form compiles to a DO block that raises when the statement succeeds", () => {
  const a = act("1. expect error: `SELECT 1/0;`");
  assert.equal(a.action, "run_sql");
  assert.equal(a.assertion, true);
  assert.deepEqual(a.expectError, { statement: "SELECT 1/0", containing: null });
  assert.match(a.sql, /EXECUTE \$doctest_q\$SELECT 1\/0\$doctest_q\$;/);
  assert.match(a.sql, /RAISE EXCEPTION 'expected an error, but the statement succeeded'/);
  assert.doesNotMatch(a.sql, /position\(/);
});
check("`containing` pins the message, case-insensitively, through a dollar-quoted literal", () => {
  const a = act("1. expect error containing `unique index`: `SELECT add_dimension('t', by_hash('user_id', 4));`");
  assert.deepEqual(a.expectError, { statement: "SELECT add_dimension('t', by_hash('user_id', 4))", containing: "unique index" });
  assert.match(a.sql, /position\(lower\(\$doctest_t\$unique index\$doctest_t\$\) IN lower\(SQLERRM\)\) = 0/);
  assert.match(a.sql, /does not mention/);
});
check("a statement with single quotes and a trailing semicolon survives unchanged inside the block", () => {
  const a = act("1. expect error: `INSERT INTO t VALUES ('a''b');`");
  assert.match(a.sql, /\$doctest_q\$INSERT INTO t VALUES \('a''b'\)\$doctest_q\$/);
});
check("the multi-line form reads the statement from the indented lines", () => {
  const a = act("1. expect error containing `partitioning`:\n   `SELECT add_dimension('t',\n   by_hash('user_id', 4));`");
  assert.equal(a.expectError.containing, "partitioning");
  assert.match(a.expectError.statement, /^SELECT add_dimension\('t',\s+by_hash\('user_id', 4\)\)$/);
});
check("forms the verb does not have are unparsed, never a check", () => {
  for (const l of ["expect error `x`: `SELECT 1`", "expect errors: `SELECT 1`", "expect error containing x: `SELECT 1`", "expect error"]) {
    assert.deepEqual(plan(`1. ${l}`).unparsed, [l], l);
  }
});
check("it counts as an assertion, so a plan ending on it is not 'no assertions'", () => {
  const p = plan("1. run SQL: `SELECT 1;`\n2. expect error: `SELECT 1/0;`");
  assert.equal(p.steps.filter((s) => s.actions.some((a) => a.assertion)).length, 1);
});

// The lint: the statement under test is the plan's copy of a page statement the prose says fails, so it
// is graded for drift like `run SQL:` and it counts as run.
const PAGE = [
  "---\ntitle: t\n---\n",
  "## Add a dimension\n\nYou get an error:\n\n```sql\nSELECT add_dimension('t', by_hash('user_id', 4));\n```\n",
].join("\n");
const withPlan = (steps) => PAGE + `\n<TestPlan>\ntarget: self-hosted\n${steps}\n</TestPlan>\n`;
check("a page statement asserted with expect error is not reported as 'not run'", () => {
  const steps = "1. expect error containing `unique`: `SELECT add_dimension('t', by_hash('user_id', 4));`";
  const notRun = statementsNotRun(withPlan(steps), plan(steps));
  assert.deepEqual(notRun, []);
});
check("the same page statement with no step covering it is still reported", () => {
  const steps = "1. run SQL: `SELECT 1;`";
  assert.ok(statementsNotRun(withPlan(steps), plan(steps)).length >= 1);
});
check("a near copy inside expect error is graded as drift, like run SQL", () => {
  const steps = "1. expect error: `SELECT add_dimension('t', by_hash('user_id', 5));`";
  const drift = statementsDriftedFromPage(withPlan(steps), plan(steps));
  assert.ok(drift.length >= 1, JSON.stringify(drift));
});

console.log(failed ? `\n${failed} check(s) failed` : "\nall checks passed");
process.exit(failed ? 1 : 0);
