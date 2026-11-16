#!/usr/bin/env node
// Checks the two pure functions in lib/report.mjs that decide what a run's report says:
// `overallVerdict`, which grades a page and which test-batch's resume and exit code depend on, and
// `collapseCascades`, which folds one cause reported many times into one line. No AWS, no browser.
//
// A check that only passes proves nothing, so most of these pair a case that must collapse (or win) with the
// near-miss that must not.
import assert from "node:assert/strict";
import { overallVerdict, collapseCascades } from "../lib/report.mjs";

let failed = 0;
const check = (name, fn) => {
  try { fn(); console.log(`  ok   ${name}`); } catch (e) { failed++; console.log(`  FAIL ${name}\n       ${String(e.message).split("\n").join("\n       ")}`); }
};

console.log("overallVerdict");
const result = (...verdicts) => ({ testable: true, procedures: verdicts.map((verdict) => ({ verdict })) });
const permutations = (xs) => (xs.length <= 1 ? [xs] : xs.flatMap((x, i) => permutations([...xs.slice(0, i), ...xs.slice(i + 1)]).map((p) => [x, ...p])));

check("a page that is not testable is skipped, whatever its procedures say", () => {
  assert.equal(overallVerdict({ testable: false, procedures: [{ verdict: "fail" }] }), "skipped");
  assert.equal(overallVerdict({ testable: false, procedures: [] }), "skipped");
});
check("fail beats blocked, stopped and pass, in every order", () => {
  for (const p of permutations(["pass", "blocked", "stopped", "fail"])) assert.equal(overallVerdict(result(...p)), "fail", p.join(","));
});
check("blocked beats stopped and pass, in every order", () => {
  for (const p of permutations(["pass", "blocked", "stopped"])) assert.equal(overallVerdict(result(...p)), "blocked", p.join(","));
});
check("stopped beats pass, in either order", () => {
  for (const p of permutations(["pass", "stopped"])) assert.equal(overallVerdict(result(...p)), "stopped", p.join(","));
});
check("all passing is pass (the control for the four above)", () => {
  assert.equal(overallVerdict(result("pass", "pass", "pass")), "pass");
});
check("known, pinned not endorsed: a testable page that ran no procedure is `pass`", () => {
  assert.equal(overallVerdict(result()), "pass");
});
check("known, pinned not endorsed: a procedure verdict it does not know is invisible to the page verdict", () => {
  assert.equal(overallVerdict(result("pass", "weird")), "pass");
});

console.log("collapseCascades");
// `step` is 0-based, as the walker numbers it; the summary prints it 1-based.
const fail = (step, error, did = `click control ${step}`) => ({ step, status: "fail", did, error });
const ok = (step) => ({ step, status: "ok", did: `did ${step}` });
const shape = "no control labelled `X` on the page";
const labelled = (name) => shape.replace("X", name);

check("three failures of one shape collapse to two lines: the first in full, then a summary naming the rest", () => {
  const out = collapseCascades([fail(5, labelled("Continue")), fail(6, labelled("Close")), fail(7, labelled("Next"))]);
  assert.equal(out.length, 2);
  assert.deepEqual(out[0], fail(5, labelled("Continue")));
  assert.equal(out[1].collapsed, 2);
  assert.equal(out[1].error, undefined);
  assert.match(out[1].did, /2 more step\(s\) failed the same way \(steps 7, 8\)/);
});
check("two failures of one shape are not yet a cascade", () => {
  const actions = [fail(5, labelled("A")), fail(6, labelled("B"))];
  assert.deepEqual(collapseCascades(actions), actions);
});
check("the shape ignores the specifics: quoted text, backticked text and numbers", () => {
  const out = collapseCascades([fail(0, 'timed out after 30 seconds waiting for "Save" on `row 4`'), fail(1, 'timed out after 45 seconds waiting for "Close" on `row 9`'), fail(2, 'timed out after 60 seconds waiting for "Done" on `row 1`')]);
  assert.equal(out.length, 2);
  assert.equal(out[1].collapsed, 2);
});
check("a different shape in the middle ends the run, so nothing collapses (the near-miss)", () => {
  const actions = [fail(0, labelled("A")), fail(1, labelled("B")), fail(2, "the dialog never closed"), fail(3, labelled("C"))];
  assert.deepEqual(collapseCascades(actions), actions);
});
check("a step that passed ends the run too", () => {
  const actions = [fail(0, labelled("A")), fail(1, labelled("B")), ok(2), fail(3, labelled("C")), fail(4, labelled("D"))];
  assert.deepEqual(collapseCascades(actions), actions);
});
check("the shape comes from the error, not from `did`: different `did` lines with one error shape collapse", () => {
  const out = collapseCascades([fail(0, labelled("A"), "click A"), fail(1, labelled("B"), "click B"), fail(2, labelled("C"), "click C")]);
  assert.equal(out.length, 2);
});
check("with no error the shape falls back to `did`", () => {
  const noError = (step, did) => ({ step, status: "fail", did });
  assert.equal(collapseCascades([noError(0, "click `A`"), noError(1, "click `B`"), noError(2, "click `C`")]).length, 2);
  const mixed = [noError(0, "click `A`"), noError(1, "type `B`"), noError(2, "click `C`")];
  assert.deepEqual(collapseCascades(mixed), mixed);
});
check("passing steps pass through in order, around and between collapsed runs", () => {
  const out = collapseCascades([ok(0), fail(1, labelled("A")), fail(2, labelled("B")), fail(3, labelled("C")), ok(4)]);
  assert.deepEqual(out.map((a) => a.step), [0, 1, 2, 4]);
  assert.equal(out[2].collapsed, 2);
});
check("two separate cascades each collapse on their own", () => {
  const out = collapseCascades([fail(0, labelled("A")), fail(1, labelled("B")), fail(2, labelled("C")), ok(3), fail(4, "boom 1"), fail(5, "boom 2"), fail(6, "boom 3")]);
  assert.deepEqual(out.map((a) => a.collapsed ?? 0), [0, 2, 0, 0, 2]);
});
check("an empty run and a run of passing steps are unchanged", () => {
  assert.deepEqual(collapseCascades([]), []);
  assert.deepEqual(collapseCascades([ok(0), ok(1)]), [ok(0), ok(1)]);
});

console.log(failed ? `\n${failed} check(s) failed` : "\nall checks passed");
process.exit(failed ? 1 : 0);
