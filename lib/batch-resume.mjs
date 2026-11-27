// What `test-batch --resume` may skip, and what makes a batch exit non-zero. Pure decisions,
// so they are checked without running a batch (scripts/check-batch-resume.mjs).
//
// Only a verdict the tool actually reached counts as done: pass, fail, blocked, stopped, and skipped (a
// saved "nothing testable", which re-running cannot change). A page whose child timed out, crashed, was
// refused, was interrupted by a signal, or ended with no saved result has no verdict, so a resume runs
// it again instead of treating the batch's own failure as an answer.
export const SETTLED = new Set(["pass", "fail", "blocked", "stopped", "skipped"]);
export const isSettled = (verdict) => SETTLED.has(verdict);

// -> { skip: pages a prior state settles, run: pages to run (never run, or run without a verdict),
//      again: [{ page, verdict }] the ones in `run` that have a prior, unsettled entry }
export function splitResume(runnable, done) {
  const skip = [];
  const run = [];
  const again = [];
  for (const page of runnable) {
    const prior = done[page.url];
    if (prior && isSettled(prior.verdict)) skip.push(page);
    else {
      run.push(page);
      if (prior) again.push({ page, verdict: prior.verdict });
    }
  }
  return { skip, run, again };
}

// A resume reuses the latest batch's state, so one started with other flags would silently skip pages
// the new flags mean to run. `prior` is the flags the batch recorded; a batch from before that was
// recorded has none, and cannot be compared. -> a sentence, or null.
export function flagsMismatch(prior, now) {
  if (!prior) return null;
  const same = (a, b) => (a ? [...a].sort().join(",") : "") === (b ? [...b].sort().join(",") : "");
  const show = (a) => (a?.length ? a.join(",") : "everything");
  for (const [flag, key] of [["--products", "products"], ["--os", "os"]]) {
    if (!same(prior[key], now[key])) return `${flag}: this batch was started with ${show(prior[key])} and you passed ${show(now[key])}. Start a new batch (drop --resume) or pass the same ${flag}.`;
  }
  return null;
}

// Batch directories are named to the second, so two started in the same second would share one state
// file. `batch-X-2` sorts after `batch-X`, so "the most recent" is still the last by name.
export function uniqueBatchName(existing, base) {
  if (!existing.includes(base)) return base;
  let n = 2;
  while (existing.includes(`${base}-${n}`)) n++;
  return `${base}-${n}`;
}

// A batch fails when a page failed or when any page ended with no verdict: a timeout or a crash is not
// a pass, and exiting 0 over one would let a CI job call a half-run batch green.
export const batchExitCode = (results) => (results.some((r) => r.verdict === "fail" || !isSettled(r.verdict)) ? 1 : 0);
