#!/usr/bin/env node
// Checks the step slicer behind `test-page --from` and `--until` (lib/slice.mjs, issue #33): resolving a
// number or a piece of a step's text, refusing a range that is empty, and which steps a slice keeps.
// No AWS, no browser.
//
// The slicer has to be right in two quiet ways. An inverted range walks nothing and reports a clean run,
// the silent no-op this project keeps finding (`--until "expect no rows"` once matched a step BEFORE
// `--from`). And a slice that starts mid-page still has to get INTO the service, so the `select the
// service` step before it is a precondition and is kept: without it `--from 55` reported "no control
// labelled `Explorer` on the page" for eight steps in a row.
import assert from "node:assert/strict";
import { stepIndex, resolveSlice, applySlice, SliceError } from "../lib/slice.mjs";

let failed = 0;
const check = (name, fn) => {
  try { fn(); console.log(`  ok   ${name}`); } catch (e) { failed++; console.log(`  FAIL ${name}\n       ${String(e.message).split("\n").join("\n       ")}`); }
};

// 8 steps; 1 and 4 navigate into a service, 6 repeats text from 3.
const step = (text, nav = false) => ({ text, actions: nav ? [{ action: "select_service" }] : [{ action: "click" }] });
const plan = {
  steps: [
    step("select the service", true), // 1
    step("Open the Explorer"), // 2
    step("Create a Continuous Aggregate"), // 3
    step("select the service again", true), // 4
    step("expect no rows: SELECT 1"), // 5
    step("Create a Continuous Aggregate, again"), // 6
    step("drop it"), // 7
    step("expect no rows: SELECT 2"), // 8
  ],
};

console.log("resolving --from and --until");
check("nothing given is the fallback", () => {
  assert.equal(stepIndex(plan, undefined, 1), 1);
  assert.equal(stepIndex(plan, "", Infinity), Infinity);
  assert.equal(stepIndex(plan, null, 7), 7);
});
check("a number is that step, as written", () => {
  assert.equal(stepIndex(plan, "5", 1), 5);
  assert.equal(stepIndex(plan, "08", 1), 8);
});
check("text matches a substring of a step, ignoring case, and gives its 1-based number", () => {
  assert.equal(stepIndex(plan, "explorer", 1), 2);
  assert.equal(stepIndex(plan, "CREATE A CONTINUOUS", 1), 3);
});
check("when text matches several steps the first one wins", () => {
  assert.equal(stepIndex(plan, "continuous aggregate", 1), 3);
  assert.equal(stepIndex(plan, "expect no rows", 1), 5);
});
check("text that matches no step is an error naming the text, never a guess", () => {
  assert.throws(() => stepIndex(plan, "nothing like this", 1), (e) => e instanceof SliceError && /no step matches "nothing like this"/.test(e.message));
});
check("a number is taken at its word even when no such step exists (checked later, by the range)", () => {
  assert.equal(stepIndex(plan, "99", 1), 99);
});

console.log("an empty range is refused");
check("--until earlier than --from by number is an error that says both numbers", () => {
  assert.throws(() => resolveSlice(plan, "6", "3"), (e) => e instanceof SliceError && /--from resolved to step 6 and --until to step 3, so the slice is empty/.test(e.message));
});
check("the bug that was caught in testing: --until text that matches a step BEFORE --from", () => {
  // "expect no rows" first matches step 5; --from 7 starts after it.
  assert.throws(() => resolveSlice(plan, "7", "expect no rows"), SliceError);
});
check("the same text with a --from before it is fine (the control for the one above)", () => {
  assert.equal(resolveSlice(plan, "3", "expect no rows").until, 5);
});
check("a one-step range is not empty", () => {
  const s = resolveSlice(plan, "5", "5");
  assert.deepEqual([s.from, s.until], [5, 5]);
});
check("no flags is the whole plan", () => {
  const s = resolveSlice(plan, undefined, undefined);
  assert.deepEqual([s.from, s.until], [1, Infinity]);
  for (let n = 1; n <= 8; n++) assert.equal(s.inSlice(n), true, `step ${n}`);
});

console.log("which steps a slice keeps");
const kept = (s) => Array.from({ length: 8 }, (_, i) => i + 1).filter(s.inSlice);
check("both ends are inclusive", () => {
  assert.deepEqual(kept(resolveSlice(plan, "5", "6")).filter((n) => n >= 5), [5, 6]);
});
check("the navigation step before the slice is kept, and reported at its own number", () => {
  // --from 5: steps 1 and 4 select the service and come before it, so both run; 2 and 3 do not.
  assert.deepEqual(kept(resolveSlice(plan, "5", "6")), [1, 4, 5, 6]);
});
check("a step before the slice that is not navigation is skipped (the control for the one above)", () => {
  const s = resolveSlice(plan, "5", "6");
  assert.equal(s.inSlice(2), false);
  assert.equal(s.inSlice(3), false);
});
check("navigation AFTER the slice is not kept", () => {
  assert.deepEqual(kept(resolveSlice(plan, "2", "3")), [1, 2, 3]); // step 4 selects the service, but after the slice
});
check("navigation inside the slice is just part of it, and nothing is kept twice", () => {
  assert.deepEqual(kept(resolveSlice(plan, "3", "5")), [1, 3, 4, 5]);
});
check("a slice starting at step 1 keeps nothing extra", () => {
  assert.deepEqual(kept(resolveSlice(plan, "1", "3")), [1, 2, 3]);
});

console.log("applying a slice keeps the numbering");
check("out-of-slice steps stay in place with nothing to do, marked; in-slice steps are untouched", () => {
  const s = resolveSlice(plan, "5", "6");
  const out = applySlice(plan.steps, s.inSlice);
  assert.equal(out.length, plan.steps.length);
  assert.deepEqual(out.map((x) => x.text), plan.steps.map((x) => x.text));
  assert.deepEqual(out.map((x) => !!x.skipOutsideSlice), [false, true, true, false, false, false, true, true]);
  for (const i of [1, 2, 6, 7]) assert.deepEqual(out[i].actions, [], `step ${i + 1} should do nothing`);
  for (const i of [0, 3, 4, 5]) assert.equal(out[i], plan.steps[i], `step ${i + 1} should be the very same step`);
});
check("the plan itself is not changed by slicing it", () => {
  const before = JSON.stringify(plan);
  applySlice(plan.steps, resolveSlice(plan, "5", "6").inSlice);
  assert.equal(JSON.stringify(plan), before);
});

console.log(failed ? `\n${failed} check(s) failed` : "\nall checks passed");
process.exit(failed ? 1 : 0);
