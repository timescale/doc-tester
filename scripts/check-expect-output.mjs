#!/usr/bin/env node
// Checks `expect output contains` and the `<Ctrl-D>` reply (docs/adr/0011): the grammar, the attach rule,
// and the lint's two ties to the page. The walker's own check runs against a box; the driver sending a
// key press is in check-pty-driver.mjs. No AWS.
import assert from "node:assert/strict";
import { parsePlan } from "../lib/plan.mjs";
import { guideCommandDrift } from "../lib/fidelity.mjs";

const HDR = "target: self-hosted\nmachine: bare\nos: ubuntu\npath: docker-ha";
const plan = (steps) => parsePlan(`<TestPlan>\n${HDR}\n${steps}\n</TestPlan>`).plans[0];
const errs = (p) => p.errors.map((e) => e.detail).join(" | ");

let failed = 0;
const check = (name, fn) => {
  try { fn(); console.log(`  ok   ${name}`); } catch (e) { failed++; console.log(`  FAIL ${name}\n       ${String(e.message).split("\n").join("\n       ")}`); }
};

const PSQL = 'psql -d "postgres://postgres:password@127.0.0.1:5432/postgres"';
const FLOW = `1. run command: \`${PSQL}\`\n2. answer \`postgres=#\` with \`\\dx\`\n3. answer \`postgres=#\` with \`<Ctrl-D>\``;

check("control: the verb parses to its text, and a plan with it has no errors", () => {
  const p = plan(`${FLOW}\n4. expect output contains \`timescaledb\``);
  assert.deepEqual(p.errors, []);
  assert.deepEqual(p.unparsed, []);
  assert.deepEqual(p.steps[3].actions, [{ action: "expect_output", text: "timescaledb" }]);
});
check("text with ', then ' stays whole, and a regex-looking one is still a plain string", () => {
  assert.equal(plan(`${FLOW}\n4. expect output contains \`a, then b\``).steps[3].actions[0].text, "a, then b");
  assert.equal(plan(`${FLOW}\n4. expect output contains \`^time.*db$\``).steps[3].actions[0].text, "^time.*db$");
});
check("forms the verb does not have are unparsed, never a check", () => {
  for (const l of ["expect output matches `timescaledb`", "expect output contains timescaledb", "expect output contains ``", "expect output"]) {
    assert.deepEqual(plan(`${FLOW}\n4. ${l}`).unparsed, [l], l);
  }
});
check("it needs a run command above it", () => {
  assert.match(errs(plan("1. expect output contains `x`")), /no `run command:` above it/);
});

// A page whose Docker HA path has what the real one has: image and container names in shell fences, and the
// sample output in a non-shell fence.
const PAGE = `<Tabs>
<TabItem label="Docker">
<Tabs>
<TabItem label="TimescaleDB-HA">
\`\`\`bash
docker run -d --name timescaledb timescale/timescaledb-ha:pg18
\`\`\`
\`\`\`bash
${PSQL}
\`\`\`
\`\`\`sql
\\dx
\`\`\`
\`\`\`sql
 Name | Version
 timescaledb_toolkit | 1.22.0
 plpgsql | 1.0
\`\`\`
</TabItem>
</Tabs>
</TabItem>
</Tabs>`;
const RUN = `1. run command: \`docker run -d --name timescaledb timescale/timescaledb-ha:pg18\`\n2. run command: \`${PSQL}\`\n3. answer \`postgres=#\` with \`\\dx\`\n4. answer \`postgres=#\` with \`<Ctrl-D>\``;
const kinds = (steps) => guideCommandDrift(PAGE, plan(`${RUN}\n${steps}`)).map((d) => d.kind);

check("control: text the sample output shows is clean, and a <Ctrl-D> answer is not 'command not on page'", () => {
  assert.deepEqual(kinds("5. expect output contains `timescaledb_toolkit`"), []);
});
check("a `\\q` answer is still 'command not on page' (the exemption is the key token, not psql prompts)", () => {
  const k = guideCommandDrift(PAGE, plan(`${RUN.replace("<Ctrl-D>", "\\q")}`)).map((d) => d.kind);
  assert.deepEqual(k, ["command not on page"]);
});
check("text only in a shell fence (the image tag) is not shown by the page", () => {
  assert.deepEqual(kinds("5. expect output contains `timescaledb-ha:pg18`"), ["asserts text the page never shows"]);
});
check("known ceiling: it is a substring, so `timescaledb` is satisfied by the `timescaledb_toolkit` row alone", () => {
  assert.deepEqual(kinds("5. expect output contains `timescaledb`"), []);
});
check("text on the page nowhere, and a made-up extension, are not shown", () => {
  assert.deepEqual(kinds("5. expect output contains `pg_stat_statements`"), ["asserts text the page never shows"]);
});
check("text the plan itself types is flagged, even when the page shows it (the terminal echoes it)", () => {
  assert.ok(kinds("5. expect output contains `Version`").length === 0, "control: Version is shown and not typed");
  const k = guideCommandDrift(PAGE, plan(`${RUN.replace("`\\dx`", "`\\dx timescaledb_toolkit`")}\n5. expect output contains \`timescaledb_toolkit\``)).map((d) => d.kind);
  assert.ok(k.includes("asserts text the plan itself types"), k.join(","));
});
check("the check follows the command above it: text typed for an earlier command is not 'typed' for this one", () => {
  const k = guideCommandDrift(PAGE, plan(`${RUN.replace("`\\dx`", "`\\dx timescaledb_toolkit`")}\n5. run command: \`${PSQL}\`\n6. expect output contains \`timescaledb_toolkit\``)).map((d) => d.kind);
  assert.ok(!k.includes("asserts text the plan itself types"), k.join(","));
});

console.log(failed ? `\n${failed} check(s) failed` : "\nall checks passed");
process.exit(failed ? 1 : 0);
