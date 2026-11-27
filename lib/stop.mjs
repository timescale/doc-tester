// A request to stop the run: Ctrl-C, or a SIGTERM from the batch runner's timeout or a cancelled job.
//
// The signal handler tears nothing down itself. The fork, the EC2 box, the browser and the project
// sweep belong to the run's own `finally` blocks, and a handler that called process.exit() skipped
// them: that is how an interrupted run used to leave its fork billing. So the handler only records
// the request, and the run reads it between steps. The step in flight finishes (a Console step) or is
// cut at its next poll (a command on the EC2 box), every later step is reported `stopped`, and the run
// goes through its normal teardown and report. The long polls (an EC2 box registering with SSM, the
// EC2 slot, a service becoming READY) read it too, so an interrupt during provisioning does not wait
// the poll out.
//
// A second Ctrl-C means now: the handler prints what a hard exit leaves behind and exits 130. Only a
// repeated SIGINT counts, because that is what a person at a terminal produces; a SIGTERM after a
// SIGINT is what a GitHub Actions cancel sends (SIGINT, SIGTERM 7.5 s later, then a kill at 10 s), and
// treating it as "now" would throw away the little cleanup that budget allows. SIGHUP (a closed
// terminal) is a first signal like the others.
//
// Playwright installs handlers of its own on these signals, exiting on SIGINT and closing the browser
// on the others, which would skip or break the teardown here: the launch sites turn them off.

let reason = null;

export const stopRequested = () => reason !== null;
export const stopReason = () => reason;
export function requestStop(why) {
  reason ??= why;
}
// For the checks, which run several cases in one process.
export function resetStop() {
  reason = null;
}

export class StoppedError extends Error {
  constructor(during) {
    super(`the run was interrupted (${reason})${during ? ` while ${during}` : ""}`);
    this.code = "STOPPED";
    this.during = during;
  }
}

// For polls: a throw ends the wait, and the caller's own teardown runs.
export function throwIfStopped(during) {
  if (reason !== null) throw new StoppedError(during);
}

// The report line for a step that did not run because of the stop.
export const stoppedLine = (step, what = "stopped here") => ({ step, did: `${what}: the run was interrupted (${reason})`, status: "stopped" });

// Install once per process. `leftovers()` lists what a hard exit would leave behind, each with the
// command that removes it; `onFirst` and `onSecond` run before the request is recorded and before
// the exit respectively. `onSecond` may be async (releasing the project lock is one psql call) or return nothing.
export function installStopHandler({ leftovers = () => [], onFirst = () => {}, onSecond = async () => {} } = {}) {
  for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"]) {
    process.on(sig, async () => {
      if (reason === null) {
        onFirst(sig);
        requestStop(sig);
        return;
      }
      if (sig !== "SIGINT") return; // already stopping; see the header on why only a repeated Ctrl-C quits
      const left = leftovers();
      console.error(`\n  ${sig} again: quitting without cleanup.${left.length ? ` Left behind, with the command that removes it:\n${left.map((l) => `    ${l}`).join("\n")}` : ""}`);
      try { await onSecond(); } catch { /* best effort: the exit is the point */ }
      process.exit(130);
    });
  }
}
