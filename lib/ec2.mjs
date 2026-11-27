// EC2-mode plumbing for the self-hosted TimescaleDB target, via infra/'s Terraform + SSM (NOT the
// Tiger CLI, NOT Playwright). Mirrors lib/fork.mjs's role for Tiger Cloud, but for the ad hoc EC2
// substrate — see docs/adr/0004 (why a plan opts into this at all) and docs/adr/0005 (why ad hoc
// per page, not standing).
//
// terraform state is incremental: a resource can exist even if apply() throws partway through, so
// callers must track "did we call apply()" *before* calling it, not "did it succeed" — and always
// attempt destroy() once that's true, the same way test-page.mjs's existing fork teardown already
// runs regardless of walk outcome.

import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { connect } from "node:net";
import { existsSync, unlinkSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import * as slot from "./slot.mjs";
import { awsEnv } from "./aws-env.mjs";

const execFileP = promisify(execFile);
const INFRA_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "infra");

// Every `aws` and terraform child gets the identity DOCTEST_AWS_PROFILE decides (lib/aws-env.mjs):
// the profile passed explicitly, never an ambient AWS_PROFILE that could point this at the wrong
// account, or no profile at all on a machine that authenticates with a role.
const AWS_ENV = awsEnv();

// A failed terraform run says WHY on stderr, and execFile's own message says only "Command failed:
// up.sh". Two plans on 2026-09-28 reported exactly that and nothing else, so the reason (a lock, an
// IAM name not yet released, a quota) had to be guessed. Carry the last lines of stderr in the error.
async function runInfra(script, extraEnv = {}) {
  try {
    await execFileP(join(INFRA_DIR, script), [], {
      env: { ...AWS_ENV, DOCTEST_TF_AUTO_APPROVE: "1", ...extraEnv },
      timeout: 5 * 60 * 1000,
      maxBuffer: 16 * 1024 * 1024,
    });
  } catch (e) {
    const tail = String(e.stderr || "").replace(/\x1b\[[0-9;]*m/g, "").trim().split("\n").filter(Boolean).slice(-8).join(" | ");
    throw new Error(`${script} failed${e.killed ? " (timed out)" : ""}${tail ? `: ${tail}` : ""}`);
  }
}

// Resources the tool created that Terraform has forgotten. On 2026-10-08 the laptop lost DNS seconds
// after an apply had created its six resources: the state push and the lock release both failed, so
// S3 kept an empty state under a held lock, the box kept running and billing, and every later run
// died on the lock or on names already taken. Terraform saves the state it could not upload as
// `errored.tfstate`; pushing it is the documented recovery, and the tool's own destroy then removes
// exactly the per-run set it always removes. Without that file, orphans are only reported: the tool
// never deletes what is not in its state.
const ERRORED_STATE = join(INFRA_DIR, "errored.tfstate");
const INSTANCE_TAG = "doc-testing-tool-ec2";

async function stateHasInstance() {
  const { stdout } = await execFileP("terraform", ["state", "list"], { cwd: INFRA_DIR, env: AWS_ENV, timeout: 60_000 });
  return stdout.split("\n").some((l) => l.trim() === "aws_instance.ec2");
}

export async function orphanInstances(tag = INSTANCE_TAG) {
  const { stdout } = await execFileP(
    "aws",
    ["ec2", "describe-instances", "--region", "us-east-1", "--filters", `Name=tag:Name,Values=${tag}`, "Name=instance-state-name,Values=pending,running,stopping,stopped", "--query", "Reservations[].Instances[].[InstanceId,LaunchTime]", "--output", "text"],
    { env: AWS_ENV, timeout: 30_000 },
  );
  return stdout.trim().split("\n").filter(Boolean).map((l) => { const [id, launched] = l.split(/\s+/); return { id, launched }; });
}

export async function preflight({ log = console.log } = {}) {
  // Everything below reads or writes Terraform state, which needs an initialized working directory.
  // A fresh clone has none, so initialize here rather than leave it as a manual first step.
  await runInfra("init.sh");
  if (existsSync(ERRORED_STATE)) {
    log(`  a previous apply could not save its state (${ERRORED_STATE}); pushing it and destroying what it created...`);
    await execFileP("terraform", ["state", "push", ERRORED_STATE], { cwd: INFRA_DIR, env: AWS_ENV, timeout: 60_000 });
    await destroy();
    unlinkSync(ERRORED_STATE);
    log("  recovered: the previous run's resources are destroyed and its saved state is gone.");
  }
  if (await stateHasInstance()) {
    // apply() holds the slot's lease before it gets here (docs/adr/0009), so whoever made this box is
    // gone: a crashed run, or one whose lease expired. Reusing it would hand this run a dirty machine.
    log("  a box from a dead run is still in state; destroying it first...");
    await runInfra("down.sh");
  }
  const orphans = await orphanInstances();
  if (orphans.length) {
    throw new Error(
      `Terraform state has no instance, but ${orphans.length} instance(s) tagged ${INSTANCE_TAG} exist: ${orphans.map((o) => `${o.id} (since ${o.launched})`).join(", ")}. ` +
        `A previous apply created them without saving state. Import them (terraform import aws_instance.ec2 <id>, and the security group, role, profile, policy attachment and SSM parameter), then run infra/down.sh. Nothing is deleted automatically.`,
    );
  }
}

// The user commands run as on a bare target: the AMI's default non-root user, with passwordless sudo,
// so a guide step missing its `sudo` fails the way it fails for a reader (docs/adr/0007). It differs
// by distro, so each distro in OSES (lib/plan.mjs) has a row here and an AMI in infra/ (docs/adr/0008).
const BARE_USERS = { ubuntu: "ubuntu", debian: "admin", rocky: "rocky", fedora: "fedora", redhat: "ec2-user", arch: "arch" };
export const bareUser = (os) => {
  if (!BARE_USERS[os]) throw new Error(`no default user known for os "${os}"; add it to BARE_USERS in lib/ec2.mjs`);
  return BARE_USERS[os];
};

// `bare` skips the cloud-init install (infra's `bare` variable): the box is only the OS, and an
// install-guide run installs the database itself. destroy() needs no flag: it removes whatever is in state.
export async function apply({ bare = false, os = "ubuntu" } = {}) {
  // One run at a time: the lease is held from here until destroy() (docs/adr/0009). A busy slot throws
  // SlotBusyError (code SLOT_BUSY) before anything is provisioned.
  await slot.acquire({ purpose: `${os}${bare ? " bare" : ""}` });
  await preflight();
  await runInfra("up.sh", { TF_VAR_bare: String(bare), TF_VAR_os: os });
}

// Only the holder of the slot's lease may destroy the box in state: it is the holder's. Called with no
// lease held (a standalone teardown), it takes the lease first and throws SlotBusyError if a live run has it.
export async function destroy() {
  await slot.acquire({ purpose: "destroy", waitMs: 0 });
  await slot.assertHeld();
  try {
    await runInfra("down.sh");
  } finally {
    await slot.release();
  }
}

export async function instanceId() {
  const { stdout } = await execFileP("terraform", ["output", "-raw", "instance_id"], {
    cwd: INFRA_DIR,
    env: AWS_ENV,
    timeout: 30_000,
  });
  return stdout.trim();
}

// Registration can lag RunInstances by 30-90s — neither send-command nor start-session works
// before the instance's SSM agent has actually checked in.
// 3 minutes was not enough on 2026-09-28: a box registered with SSM a little after the wait gave up,
// the run failed on step 1, and the box it then tried to destroy was still booting. Boot time is
// the AMI's and the mirrors' to decide, so the wait is generous rather than tight.
export async function waitForSsmRegistration(id, { timeoutMs = 8 * 60 * 1000, intervalMs = 10_000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const { stdout } = await execFileP(
      "aws",
      ["ssm", "describe-instance-information", "--filters", `Key=InstanceIds,Values=${id}`, "--query", "InstanceInformationList[0].PingStatus", "--output", "text"],
      { env: AWS_ENV, timeout: 30_000 }
    ).catch(() => ({ stdout: "" }));
    if (stdout.trim() === "Online") return;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(`instance ${id} never registered with SSM within ${timeoutMs}ms`);
}

// Run a shell command on the instance via SSM Run Command, and wait for it to finish. Shared by
// waitForCloudInit() below and lib/walk-ec2.mjs's `run command:` steps — one polling loop, not two.
export async function sendCommand(id, command, { timeoutMs = 2 * 60 * 1000, intervalMs = 2000 } = {}) {
  const { stdout: commandId } = await execFileP(
    "aws",
    // One working directory for every command, writable by root and by `sudo -u postgres` alike, so a
    // plan can write the page's own relative filenames (`> schema.sql`, `\COPY … TO conditions.csv`)
    // and the next step finds them. Without it each command lands wherever the SSM agent happens to be.
    ["ssm", "send-command", "--instance-ids", id, "--document-name", "AWS-RunShellScript", "--parameters", JSON.stringify({ commands: [command], workingDirectory: ["/tmp"] }), "--query", "Command.CommandId", "--output", "text"],
    { env: AWS_ENV, timeout: 30_000 }
  );
  return pollCommand(commandId.trim(), id, { timeoutMs, intervalMs });
}

async function pollCommand(commandId, instanceId, { timeoutMs = 2 * 60 * 1000, intervalMs = 2000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const { stdout } = await execFileP("aws", ["ssm", "get-command-invocation", "--command-id", commandId, "--instance-id", instanceId, "--output", "json"], {
      env: AWS_ENV,
      timeout: 30_000,
    }).catch(() => ({ stdout: "{}" }));
    const inv = JSON.parse(stdout || "{}");
    if (inv.Status && !["Pending", "InProgress", "Delayed"].includes(inv.Status)) return inv;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(`command ${commandId} on ${instanceId} did not finish within ${timeoutMs}ms`);
}

// cloud-init finishing (apply() returning) only means the EC2 API call succeeded — TimescaleDB's
// install still takes a couple of minutes after that. Poll cloud-init's own --wait rather than
// guessing a fixed sleep, the same reason openTunnel() below polls for the socket instead of one.
//
// Ten minutes, not sendCommand's two: the install is an apt run against whatever mirror the box
// gets, and on 2026-10-08 one box took longer than two minutes and the page was reported blocked
// for a reason that had nothing to do with the docs. The walker's own commands already get ten.
export async function waitForCloudInit(id, opts = {}) {
  const inv = await sendCommand(id, "cloud-init status --wait", { timeoutMs: 10 * 60 * 1000, ...opts });
  if (inv.Status !== "Success") throw new Error(`cloud-init did not finish cleanly on ${id}: ${inv.Status} — ${(inv.StandardErrorContent || "").trim()}`);
}

// Opens the SSM port-forward as a background process and waits until the local port actually
// accepts a connection — a fixed sleep here is exactly the flakiness this design otherwise avoids.
export async function openTunnel(id, { localPort, timeoutMs = 30_000 } = {}) {
  const port = Number(localPort || process.env.DOCTEST_EC2_LOCAL_PORT || 55432);
  // A listener already on the port is a stale tunnel, not ours: the readiness poll below would
  // accept it and every psql of the run would then hang on a forward to an instance that no longer
  // exists (postgres-config, 2026-09-28: six red steps and no stderr). Refuse, and name the fix.
  if (await portAccepts(port)) {
    throw new Error(`local port ${port} is already in use — a stale SSM tunnel is probably still listening; \`lsof -nP -iTCP:${port}\` names it`);
  }
  // detached: `aws ssm start-session` spawns session-manager-plugin as a child, and it is the plugin
  // that holds the port. Killing only the aws parent orphaned the plugin twice today; with its own
  // process group, closeTunnel() can kill both at once.
  const proc = spawn(
    "aws",
    ["ssm", "start-session", "--target", id, "--document-name", "AWS-StartPortForwardingSession", "--parameters", JSON.stringify({ portNumber: ["5432"], localPortNumber: [String(port)] })],
    { env: AWS_ENV, stdio: ["ignore", "pipe", "pipe"], detached: true }
  );
  let stderr = "";
  proc.stderr.on("data", (d) => (stderr += d.toString()));

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (proc.exitCode !== null) throw new Error(`tunnel process exited early: ${stderr.trim() || "no output"}`);
    if (await portAccepts(port)) return { proc, localPort: port };
    await new Promise((r) => setTimeout(r, 500));
  }
  proc.kill();
  throw new Error(`tunnel to ${id}:5432 never accepted a connection within ${timeoutMs}ms: ${stderr.trim()}`);
}

function portAccepts(port) {
  return new Promise((resolve) => {
    const sock = connect({ port, host: "127.0.0.1" });
    sock.once("connect", () => {
      sock.destroy();
      resolve(true);
    });
    sock.once("error", () => resolve(false));
  });
}

export function closeTunnel(tunnel) {
  const pid = tunnel?.proc?.pid;
  if (!pid) return;
  try {
    process.kill(-pid, "SIGTERM"); // the whole group: aws AND the session-manager-plugin holding the port
  } catch {
    tunnel.proc.kill();
  }
}

// The Terraform-generated postgres password (docs/adr/0003) — never in .env, never invented.
export async function dbPassword() {
  const { stdout } = await execFileP("aws", ["ssm", "get-parameter", "--name", "/doc-testing-tool/ec2/db-password", "--with-decryption", "--query", "Parameter.Value", "--output", "text"], {
    env: AWS_ENV,
    timeout: 30_000,
  });
  return stdout.trim();
}
