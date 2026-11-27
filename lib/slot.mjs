// The one EC2 slot (one Terraform state, one aws_instance.ec2) as an exclusive lease, so two runs
// cannot replace or destroy each other's box (docs/adr/0009). The lease is an object in the
// state bucket, created with a conditional write (If-None-Match: *), which S3 makes atomic and which
// docs-tester's boundary already allows (docs/adr/0003). It outlives any single terraform command,
// which is the one thing the S3 lockfile terraform takes does not.
//
// ponytail: no heartbeat. A holder that dies without releasing blocks the slot until its lease
// expires (DOCTEST_SLOT_TTL_MIN, 60 by default); `node scripts/slot.mjs down --force` ends that early.
// A run that outlives its own lease loses it, and its destroy then refuses (assertHeld).

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { hostname, tmpdir, userInfo } from "node:os";
import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { TFSTATE_BUCKET, requireAws } from "./services.mjs";
import { awsEnv } from "./aws-env.mjs";

const execFileP = promisify(execFile);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// The same identity rule as lib/ec2.mjs (lib/aws-env.mjs), and the bucket infra/init.sh hands to the Terraform backend.
const AWS_ENV = awsEnv();
// The bucket is asked for on the first S3 call, not on import, so a Cloud-only setup never has to name it.
const bucket = () => TFSTATE_BUCKET ?? requireAws().tfstateBucket;
// Overridable so scripts/live-check-slot.mjs can exercise the lease without touching the live one.
const key = () => process.env.DOCTEST_SLOT_KEY || "doc-testing-tool/ec2/slot.lease.json";
const TTL_MS = (Number(process.env.DOCTEST_SLOT_TTL_MIN) || 60) * 60_000;
const WAIT_MS = (process.env.DOCTEST_SLOT_WAIT_MIN === undefined ? 15 : Number(process.env.DOCTEST_SLOT_WAIT_MIN)) * 60_000;

// A failed call says why: execFile's own message is only the command line, and the reason (a profile
// that does not exist, a credential that expired, a bucket in another account) is on stderr.
const s3api = (args) =>
  execFileP("aws", ["s3api", ...args, "--region", "us-east-1"], { env: AWS_ENV, timeout: 30_000 }).catch((e) => {
    const why = String(e.stderr || "").trim().split("\n").filter(Boolean).pop();
    if (why) e.message = `aws s3api ${args[0]}: ${why}`;
    throw e;
  });
const etagOf = (stdout) => stdout.trim().replace(/"/g, "");

let held = null; // { id, etag }: set while this process believes it holds the lease

export class SlotBusyError extends Error {
  constructor(message, lease) {
    super(message);
    this.code = "SLOT_BUSY";
    this.lease = lease;
  }
}

export const describe = (l) => `${l.holder} (pid ${l.pid}, ${l.purpose}), since ${l.startedAt}, lease expires ${l.expiresAt}`;

// null when a precondition failed: someone else wrote first.
async function put(lease, condition) {
  const dir = mkdtempSync(join(tmpdir(), "slot-"));
  const file = join(dir, "lease.json");
  writeFileSync(file, JSON.stringify(lease));
  try {
    const { stdout } = await s3api(["put-object", "--bucket", bucket(), "--key", key(), "--body", file, ...condition, "--query", "ETag", "--output", "text"]);
    return etagOf(stdout);
  } catch (e) {
    if (/PreconditionFailed|ConditionalRequestConflict/.test(String(e.stderr))) return null;
    throw e;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// { lease, etag }, or null when there is no lease.
export async function read() {
  const dir = mkdtempSync(join(tmpdir(), "slot-"));
  const file = join(dir, "lease.json");
  try {
    const { stdout } = await s3api(["get-object", "--bucket", bucket(), "--key", key(), file, "--query", "ETag", "--output", "text"]);
    return { lease: JSON.parse(readFileSync(file, "utf8")), etag: etagOf(stdout) };
  } catch (e) {
    if (/NoSuchKey|\b404\b/.test(String(e.stderr))) return null;
    throw e;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// Take the slot, waiting up to waitMs for a live holder to finish. An expired lease is taken over; with
// `force` a live one is too (the holder is known dead: scripts/slot.mjs down --force). Returns at once
// when this process already holds it, so apply() and destroy() can both call it.
export async function acquire({ purpose = "run", ttlMs = TTL_MS, waitMs = WAIT_MS, pollMs = 20_000, force = false, log = console.log } = {}) {
  if (held) return;
  const me = { id: randomUUID(), holder: `${userInfo().username}@${hostname()}`, pid: process.pid, purpose };
  const deadline = Date.now() + waitMs;
  let told = false;
  for (;;) {
    const now = Date.now();
    const lease = { ...me, startedAt: new Date(now).toISOString(), expiresAt: new Date(now + ttlMs).toISOString() };
    let etag = await put(lease, ["--if-none-match", "*"]);
    if (!etag) {
      const cur = await read();
      if (cur && (force || Date.parse(cur.lease.expiresAt) < now)) {
        log(`  the EC2 slot's lease ${force ? "is being taken over" : "expired"} (${describe(cur.lease)})`);
        etag = await put(lease, ["--if-match", cur.etag]);
      } else if (cur) {
        if (Date.now() >= deadline) {
          throw new SlotBusyError(
            `the EC2 slot is in use by ${describe(cur.lease)}. Wait for that run to finish; if it is dead, \`node scripts/slot.mjs down --force\` takes the slot over and destroys its box.`,
            cur.lease,
          );
        }
        if (!told) log(`  the EC2 slot is in use by ${describe(cur.lease)}; waiting up to ${Math.round(waitMs / 60_000)} min for it...`);
        told = true;
        await sleep(pollMs);
        continue;
      } else {
        await sleep(500); // released between our two calls; go round again
        continue;
      }
    }
    if (etag) {
      held = { id: me.id, etag };
      return;
    }
  }
}

// Throws unless the lease is still this process's: it may have expired and been taken over, and then
// the box in state is someone else's to destroy, not ours.
export async function assertHeld() {
  const cur = held && (await read());
  if (!cur || cur.lease.id !== held.id) {
    held = null;
    throw new SlotBusyError(`this run no longer holds the EC2 slot (its lease expired and was taken over); not touching the box in state, it is not ours. Current lease: ${cur ? describe(cur.lease) : "none"}`, cur?.lease);
  }
}

export async function release({ log = console.log } = {}) {
  if (!held) return;
  const cur = await read();
  if (cur && cur.lease.id === held.id) await s3api(["delete-object", "--bucket", bucket(), "--key", key()]);
  else log("  the EC2 slot's lease is no longer ours (it expired and was taken over); leaving it alone");
  held = null;
}
