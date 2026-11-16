// The step slicer behind `test-page --from` and `--until`, pulled out of scripts/test-page.mjs so it can be
// checked (scripts/check-slice.mjs, issue #33). It throws SliceError where the script used to print and
// exit; the script still does, with the same message and exit code 2.

export class SliceError extends Error {}

// A number OR a substring of the step's text. Numbers are what you copy off the report you are
// looking at, and they SHIFT: inserting one step earlier in the plan moved every later step by one
// today, which is also why the plan's own prose no longer cites step numbers. A substring survives
// that, so a command worth saving can be written `--from "Create a Continuous Aggregate"`.
export function stepIndex(plan, given, fallback) {
  if (!given) return fallback;
  if (/^\d+$/.test(given)) return Number(given);
  const needle = given.toLowerCase();
  const hit = plan.steps.findIndex((st) => st.text.toLowerCase().includes(needle));
  if (hit === -1) throw new SliceError(`no step matches "${given}". Use a number, or text from the step you mean.`);
  return hit + 1;
}

// -> { from, until, inSlice(n) } for 1-based step numbers.
export function resolveSlice(plan, fromGiven, untilGiven) {
  const from = stepIndex(plan, fromGiven, 1);
  const until = stepIndex(plan, untilGiven, Infinity);
  if (until < from) {
    // An inverted range walks NOTHING and reports a clean run, which is the silent no-op this project
    // keeps finding. Caught in testing: --until "expect no rows" matched a step BEFORE --from.
    throw new SliceError(`--from resolved to step ${from} and --until to step ${until}, so the slice is empty. Did the text match an earlier step?`);
  }
  // A slice that starts mid-page still has to get INTO the service. `select the service` is the step
  // that navigates there, so slicing it away leaves the walk on the project's services list, where
  // every service-scoped control is legitimately absent: `--from 55` reported "no control labelled
  // `Explorer` on the page" for eight consecutive steps. Navigation before the slice is a
  // precondition, not a step under test, so it is re-run and still reported at its own number.
  const navBeforeSlice = new Set(
    plan.steps.flatMap((s, idx) =>
      idx + 1 < from && (s.actions || []).some((a) => a.action === "select_service") ? [idx + 1] : [],
    ),
  );
  return { from, until, inSlice: (n) => (n >= from && n <= until) || navBeforeSlice.has(n) };
}

// Slice AFTER parsing, so `--from 55` means step 55 of the plan as written and the report's numbers
// still match the file. A step outside the slice keeps its place with nothing to do: a renumbered slice
// would point a reviewer at the wrong step.
export const applySlice = (steps, inSlice) => steps.map((s, idx) => (inSlice(idx + 1) ? s : { ...s, actions: [], skipOutsideSlice: true }));
