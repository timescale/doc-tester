// The EC2 walker: runs a procedure's `run_sql`/`run_shell` steps against the self-hosted target,
// no Playwright involved at all — there is no Console UI for self-hosted pages to drive. Mirrors
// lib/walk.mjs's walkProcedure in shape (same {title, verdict, actions, shots, cleanup?} output
// lib/report.mjs already consumes), but takes connection info instead of a Playwright `tab`.
//
// `expect rows:`/`expect no rows:` already compile (lib/plan.mjs) into a `DO $doctest$ ...
// RAISE EXCEPTION` block, so an assertion's pass/fail is already psql's own exit code — no
// special-casing of `action.assertion` here. `action.destructive`/allowDestructive are never read:
// per docs/adr/0005 the target is always throwaway, so every action always runs.

import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { promisify } from "node:util";
import { applyTestInputs, applyInputs, meaningfulOutput, scrubSecrets } from "./walk.mjs";
import { sendCommand } from "./ec2.mjs";
import { waitScript, waitPodScript, waitPodReadyScript } from "./wait.mjs";
import { stopRequested, stoppedLine } from "./stop.mjs";

const execFileP = promisify(execFile);

async function runPsql(sql, { localPort, password }) {
  try {
    const { stdout } = await execFileP("psql", ["-h", "localhost", "-p", String(localPort), "-U", "postgres", "-d", "postgres", "-v", "ON_ERROR_STOP=1", "-c", sql], {
      env: { ...process.env, PGPASSWORD: password },
      timeout: 60_000,
      maxBuffer: 4 * 1024 * 1024,
    });
    return { ok: true, out: stdout };
  } catch (e) {
    return { ok: false, error: (e.stderr || e.message || "").toString().trim() };
  }
}

// The pty driver (lib/pty-driver.py) is shipped to the box with each command that declares answers.
const PTY_DRIVER = readFileSync(new URL("./pty-driver.py", import.meta.url));
const PTY_MARK = "@@doctest-pty@@";
const IDLE_SECONDS = Number(process.env.DOCTEST_IDLE_SECONDS) || 120;
const b64 = (s) => Buffer.from(s).toString("base64");

// What SSM runs (as root, through sh) for a step that must run as the box's default user, the way a
// reader runs it (docs/adr/0007). The step is a file, not a quoted string, so a multi-line command or
// a heredoc reaches bash exactly as the plan wrote it; the directory belongs to the user and is gone
// afterwards. With answers it runs under the pty driver, without them as plain bash, so a prompt the
// plan never declared fails the step instead of being answered by a guess.
function asUserScript(command, { runAs, answers, redact }) {
  if (!/^[a-z_][a-z0-9_-]*$/.test(runAs)) throw new Error(`refusing to run as "${runAs}"`);
  const driven = answers?.length > 0;
  return [
    `D=$(mktemp -d /tmp/doctest-XXXXXX)`,
    `printf %s '${b64(command)}' | base64 -d > "$D/step.sh"`,
    driven ? `printf %s '${b64(PTY_DRIVER)}' | base64 -d > "$D/pty-driver.py"` : null,
    driven ? `printf %s '${b64(JSON.stringify({ answers, idle: IDLE_SECONDS, redact }))}' | base64 -d > "$D/spec.json"` : null,
    `chown -R ${runAs} "$D"; chmod 700 "$D"`,
    driven ? `sudo -u ${runAs} -H python3 "$D/pty-driver.py" "$D/step.sh" "$D/spec.json"` : `sudo -u ${runAs} -H bash "$D/step.sh"`,
    `rc=$?; rm -rf "$D"; exit $rc`,
  ].filter(Boolean).join("\n");
}

async function runViaSsm(instanceId, command, { runAs, answers, redact } = {}) {
  try {
    // Ten minutes, not the two cloud-init gets: a `go install …@latest` that fetches a toolchain, or
    // a `docker run` that pulls the HA image, is a page's own step and legitimately runs that long.
    // Declared answers always need the driver, so a pre-installed box (root, no `runAs`) runs them as
    // root rather than silently ignoring them.
    const user = runAs || (answers?.length ? "root" : null);
    const inv = await sendCommand(instanceId, user ? asUserScript(command, { runAs: user, answers, redact }) : command, { timeoutMs: 10 * 60 * 1000 });
    const out = inv.StandardOutputContent || "";
    const at = out.lastIndexOf(PTY_MARK);
    let pty = null;
    try { pty = at >= 0 ? JSON.parse(out.slice(at + PTY_MARK.length)) : null; } catch { /* a truncated tail: fall back to the status */ }
    const transcript = at >= 0 ? out.slice(0, at).trim() : out;
    if (inv.Status === "Success") return { ok: true, out: transcript, pty };
    // A driven run's stderr is part of its transcript, so the useful failure is the reason (an
    // undeclared prompt, say) plus what the script printed last, not the empty stderr SSM reports.
    const why = pty ? [pty.reason, transcript.split("\n").slice(-12).join("\n")].filter(Boolean).join("\n") : (inv.StandardErrorContent || inv.Status || "").trim();
    return { ok: false, error: why, pty, out: transcript };
  } catch (e) {
    if (e.code === "STOPPED") throw e; // an interrupt is the walk's to report, not a failed command
    return { ok: false, error: (e.message || "").toString().trim() };
  }
}

function fillConnectionPlaceholders(command, password) {
  let out = command.replace(/<\s*HOST\s*>/g, "localhost").replace(/<\s*PORT\s*>/g, "5432");
  if (password) out = out.replace(/<\s*PASSWORD\s*>/g, password);
  return out;
}

// `ensureTunnel` is for a bare target (docs/adr/0007): there is no Postgres to tunnel to until the
// plan's own steps have installed it, so the first `run SQL:`/`expect` opens the tunnel instead of
// the run opening it up front. It resolves to the local port. A pre-installed box passes `localPort`.
// `runAs` is the user commands run as on a bare target (the AMI's default non-root user, so a step
// missing its `sudo` fails here the way it fails for a reader). Absent, commands run as root, which
// is what the pre-installed box has always done.
export async function walkEc2Procedure(proc, { localPort, ensureTunnel, runAs, password, instanceId, inputs = {} } = {}) {
  const actions = [];
  let lastRun = null; // the nearest `run command:` above, for `expect output contains`
  let interrupted = false;
  for (let i = 0; i < proc.steps.length; i++) {
    // Silently, matching lib/walk.mjs:3137 — a --from/--until slice re-runs the preceding
    // `select the service`-equivalent nav step but reports nothing for steps outside the range.
    if (proc.steps[i].skipOutsideSlice) continue;
    // Ctrl-C or SIGTERM landed during the step before: report this one as the stopping point and
    // let the caller tear the box down (lib/stop.mjs).
    if (stopRequested()) {
      actions.push(stoppedLine(i));
      interrupted = true;
      break;
    }
    const stepActions = proc.steps[i].actions || [];
    if (!stepActions.length) {
      actions.push({ step: i, did: `skipped — nothing to act on in "${(proc.steps[i].title || "").slice(0, 70)}"`, status: "skipped" });
      continue;
    }
    // A stop that lands while a command is running on the box ends the poll for it (lib/ec2.mjs
    // pollCommand) with a STOPPED error: this step is the stopping point, reported as cut short rather
    // than as a failed command, and the caller destroys the box with the command still running on it.
    try {
      for (const action of stepActions) {
        if (action.action === "run_sql") {
          const sql = applyTestInputs(applyInputs(action.sql, inputs));
          const port = localPort ?? (await ensureTunnel?.().catch((e) => ({ error: e.message })));
          const res = typeof port === "number" ? await runPsql(sql, { localPort: port, password }) : { ok: false, error: port?.error || "no SSM tunnel to the box" };
          actions.push({
            step: i,
            did: res.ok ? `ran SQL through psql — ${meaningfulOutput(scrubSecrets(res.out)).slice(0, 160) || "no output"}` : "ran SQL through psql — failed",
            status: res.ok ? "ok" : "fail",
            error: res.ok ? undefined : scrubSecrets(res.error),
          });
        } else if (action.action === "run_shell") {
          // <HOST>, <PORT> and <PASSWORD> are how house style writes the connection details a reader
          // pastes in, and lib/walk.mjs fills the first two on the Console path. On the box the same
          // gaps have one answer each: the server on localhost:5432 and the Terraform-generated
          // password test-page.mjs already holds. Filled so a plan can run a documented client
          // invocation as the page prints it (`timescaledb-parallel-copy --connection "host=<HOST> …
          // password=<PASSWORD> …"` on schema-then-data) instead of rewriting it around peer auth.
          const written = applyTestInputs(applyInputs(action.command, inputs));
          const command = fillConnectionPlaceholders(written, password);
          // The answers a plan declares for this command (docs/adr/0007). `shown` is what the plan wrote,
          // placeholders and all, and is all the report ever says; `reply` is what gets typed.
          const answers = (action.answers || []).map((a) => {
            const shown = applyTestInputs(applyInputs(a.reply, inputs));
            // `<Enter>` is a bare Enter: "Press Enter to continue" has no text to type, and an empty
            // backtick pair is not something the grammar can write.
            return { prompt: a.prompt, reply: shown === "<Enter>" ? "" : shown === "<Ctrl-D>" ? "\x04" : fillConnectionPlaceholders(shown, password), raw: shown === "<Ctrl-D>" || undefined, shown, each: a.each };
          });
          const res = await runViaSsm(instanceId, command, { runAs, answers, redact: [password] });
          // The same prompt answered N times reads as one entry with a count.
          const counts = new Map();
          for (const a of res.pty?.answered || []) counts.set(`\`${a.prompt}\` with \`${a.reply}\``, (counts.get(`\`${a.prompt}\` with \`${a.reply}\``) || 0) + 1);
          const said = counts.size ? ` — answered ${[...counts].map(([k, n]) => (n > 1 ? `${k} (×${n})` : k)).join(", ")}` : "";
          const unasked = res.pty?.not_asked?.length ? ` (never asked: ${res.pty.not_asked.map((p) => `\`${p}\``).join(", ")})` : "";
          const where = `on the EC2 target${runAs ? ` as ${runAs}` : ""}`;
          // The report shows the command as the plan wrote it, placeholders and all: the filled one
          // carries the box's password, and a report is attachable to a PR.
          actions.push({
            step: i,
            did: res.ok ? `ran \`${scrubSecrets(written)}\` ${where}${said}${unasked} — ${meaningfulOutput(scrubSecrets(res.out), 2).slice(0, 160) || "no output"}` : `ran \`${scrubSecrets(written)}\`${said} — failed`,
            status: res.ok ? "ok" : "fail",
            error: res.ok ? undefined : scrubSecrets(res.error),
          });
          lastRun = { ok: res.ok, out: res.out ?? "" };
        } else if (action.action === "expect_output") {
          // Checked here, at its own step, against the command above (docs/adr/0011), so the report puts
          // the failure on the line that says what the reader should have seen.
          if (!lastRun?.ok) actions.push({ step: i, did: `not checked — the command above did not succeed`, status: "skipped" });
          else if (lastRun.out.includes(action.text)) actions.push({ step: i, did: `the output contains \`${action.text}\``, status: "ok" });
          else actions.push({ step: i, did: `the output does not contain \`${action.text}\``, status: "fail", error: `the command's output ended:\n${scrubSecrets(lastRun.out.split("\n").slice(-12).join("\n"))}` });
        } else if (action.action === "wait_postgres" || action.action === "wait_pod_ready") {
          // The reader's pause between starting a container and using it (docs/adr/0011). The report says
          // how long it took, so a guide whose container takes ten seconds longer than last month shows.
          const script = action.action === "wait_pod_ready" ? waitPodReadyScript(action.pod, action.seconds) : action.pod ? waitPodScript(action.pod, action.seconds) : waitScript(action.container, action.seconds);
          const res = await runViaSsm(instanceId, script, { runAs });
          const waited = res.out?.match(/waited (\d+)s/)?.[1];
          const what = action.action === "wait_pod_ready" ? `pod \`${action.pod}\` to be Ready` : action.pod ? `postgres in pod \`${action.pod}\`` : `postgres in container \`${action.container}\``;
          actions.push({
            step: i,
            did: res.ok ? `waited ${waited ?? "?"}s for ${what} (limit ${action.seconds}s)` : `waited for ${what} (limit ${action.seconds}s) — failed`,
            status: res.ok ? "ok" : "fail",
            // The probe says why on stdout (the container's own log, or that it does not exist); SSM's
            // stderr is only "exit status 5".
            error: res.ok ? undefined : scrubSecrets([res.out, res.error].filter(Boolean).join("\n")),
          });
        } else if (action.action === "answer") {
          // Declared here, typed by the command above it (lib/plan.mjs attaches it); nothing to run.
          actions.push({ step: i, did: `declared: types \`${action.reply}\` when \`${action.prompt}\` appears`, status: "ok" });
        } else if (action.action === "skip_command") {
          // Declared in the plan (docs/adr/0010), checked by the lint, and not run. Reported as skipped,
          // never as a pass, so the report shows which guide commands this run did not take.
          actions.push({ step: i, did: `declared skip: \`${action.command}\` — ${action.reason}`, status: "skipped" });
        } else if (action.action === "noted") {
          // test-page.mjs rewrites the `fork the service` step into one of these once
          // provisioning has happened — same treatment `fork the service`/`download <url>` already
          // get on the Console path. Also how a provisioning failure marks every remaining step
          // blocked, without this walker attempting a psql/SSM call it already knows will fail.
          actions.push({ step: i, did: action.did, status: action.status || "ok" });
        } else if (action.action === "fork_service") {
          // Only reached if a fork line somehow wasn't rewritten before the walk started — the normal
          // case is the `noted` branch above. Guard anyway so this doesn't fall to "unknown action"
          // and misreport what actually happened.
          continue;
        } else {
          actions.push({ step: i, did: `skipped — the EC2 walker has no browser and does not know "${action.action}"`, status: "skipped" });
        }
      }
    } catch (e) {
      if (e.code !== "STOPPED") throw e;
      actions.push(stoppedLine(i, "stopped mid-step"));
      interrupted = true;
      break;
    }
  }
  const verdict = actions.some((a) => a.status === "fail") ? "fail" : actions.some((a) => a.status === "blocked") ? "blocked" : interrupted ? "stopped" : "pass";
  return { title: proc.title, verdict, actions, shots: [], stepTitles: proc.steps.map((s) => s.title || "") };
}
