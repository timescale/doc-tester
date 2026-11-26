#!/usr/bin/env node
// Checks which lines of a page's shell fences the coverage lint treats as statements a plan must run
// (lib/fidelity.mjs SHELL_SHAPE, statementsNotRun). A client on the list makes its line a statement;
// a line the list does not know is invisible to the lint, so a plan can run a stale copy of it and
// lint clean. The `openssl` case is the one that was missed on the strict-SSL page. No AWS, no docs
// checkout.
import assert from "node:assert/strict";
import { parsePlan } from "../lib/plan.mjs";
import { statementsNotRun } from "../lib/fidelity.mjs";

let failed = 0;
const check = (name, fn) => {
  try { fn(); console.log(`  ok   ${name}`); } catch (e) { failed++; console.log(`  FAIL ${name}\n       ${String(e.message).split("\n").join("\n       ")}`); }
};

const ISSUER = "openssl s_client -starttls postgres -connect <HOST>:<PORT> < /dev/null 2>/dev/null | openssl x509 -noout -issuer";
const OLD_GREP = 'openssl s_client -showcerts -partial_chain -starttls postgres -connect <HOST>:<PORT> < /dev/null 2>/dev/null | grep "Google\\|ZeroSSL"';
const PAGE = [
  "---\ntitle: t\n---\n",
  "## Verify the certificate\n\nPrint the issuer:\n\n```shell\n" + ISSUER + "\n```\n",
  "## Copy the bundle\n\n```shell\npbcopy < bundle.crt\n```\n",
].join("\n");
const plan = (steps) => parsePlan(`<TestPlan>\ntarget: cloud\n${steps}\n</TestPlan>`).plans[0];
const withPlan = (steps) => PAGE + `\n<TestPlan>\ntarget: cloud\n${steps}\n</TestPlan>\n`;
const notRun = (steps) => statementsNotRun(withPlan(steps), plan(steps)).map((d) => d.statement);

check("a plan that runs the page's openssl line is clean", () => {
  const steps = "1. run command: `" + ISSUER.replace("<HOST>:<PORT>", "db.example:5432") + "`";
  assert.deepEqual(notRun(steps), []);
});
check("a plan that runs an older openssl line instead is told the page's line is not run (the strict-SSL miss)", () => {
  const steps = "1. run command: `" + OLD_GREP.replace("<HOST>:<PORT>", "db.example:5432") + "`";
  const out = notRun(steps);
  assert.equal(out.length, 1, JSON.stringify(out));
  assert.match(out[0], /^openssl s_client -starttls postgres/);
});
check("known: a clipboard line is not a statement, so a plan need not run it and the lint cannot see it drift", () => {
  const steps = "1. run command: `" + ISSUER.replace("<HOST>:<PORT>", "db.example:5432") + "`";
  assert.ok(!notRun(steps).some((s) => /pbcopy/.test(s)));
});

process.exit(failed ? 1 : 0);
