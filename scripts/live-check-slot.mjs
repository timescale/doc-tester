#!/usr/bin/env node
// Checks the EC2 slot lease (lib/slot.mjs, docs/adr/0009) against the real state bucket, using a
// throwaway lease key so the live lease is never touched. Needs docs-tester credentials; creates no EC2
// resources (the apply/destroy checks refuse before terraform runs). Exits non-zero on any failed check.
// Named live-check-*, not check-*: `npm run check` and CI run every check-*.mjs with no credentials, and this
// one cannot run there. Run it by hand with `npm run check:live`.
import { spawn, execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";

const KEY = `doc-testing-tool/ec2/_check-slot-${randomUUID().slice(0, 8)}.json`;
process.env.DOCTEST_SLOT_KEY = KEY;
process.env.DOCTEST_SLOT_WAIT_MIN = "0"; // a busy slot fails at once unless a check asks to wait
const ROOT = join(import.meta.dirname, "..");
const slot = await import("../lib/slot.mjs");
const ec2 = await import("../lib/ec2.mjs");
const { TFSTATE_BUCKET } = await import("../lib/services.mjs");
const { awsEnv } = await import("../lib/aws-env.mjs");

const aws = (...a) => execFileSync("aws", ["s3api", ...a, "--bucket", TFSTATE_BUCKET, "--key", KEY, "--region", "us-east-1"], { env: awsEnv(), encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
// A second process: it has its own pid and its own in-memory lease, which is the whole point.
const child = (code) => {
  const p = spawn("node", ["--input-type=module", "-e", `import * as slot from "${ROOT}/lib/slot.mjs"; ${code}`], { env: process.env });
  let out = "";
  p.stdout.on("data", (d) => (out += d));
  p.stderr.on("data", (d) => (out += d));
  return { done: new Promise((r) => p.on("close", () => r(out.trim()))), kill: () => p.kill() };
};
const tryAcquire = `try { await slot.acquire({ waitMs: 0, log: () => {} }); console.log("WON"); await new Promise(r => setTimeout(r, HOLD)); } catch (e) { console.log(e.code === "SLOT_BUSY" ? "BUSY " + e.message : "ERR " + e.message); }`;
const hold = (ms) => tryAcquire.replace("HOLD", ms);
let failed = 0;
const check = async (name, fn) => {
  try { await fn(); console.log(`  ok   ${name}`); } catch (e) { failed++; console.log(`  FAIL ${name}\n       ${String(e.message).split("\n").join("\n       ")}`); }
};
const wipe = async () => { await slot.acquire({ force: true, waitMs: 0, log: () => {} }).catch(() => {}); await slot.release({ log: () => {} }).catch(() => {}); };

try {
  await check("a free slot is acquired, and the lease names its holder", async () => {
    await slot.acquire({ purpose: "check", log: () => {} });
    const cur = await slot.read();
    assert.equal(cur.lease.pid, process.pid);
    assert.equal(cur.lease.purpose, "check");
  });

  await check("another process is refused while it is held, and told who holds it", async () => {
    const out = await child(hold(0)).done;
    assert.match(out, /^BUSY the EC2 slot is in use by /);
    assert.ok(out.includes(`pid ${process.pid}`), out);
  });

  await check("control: once released, the same process can take it", async () => {
    await slot.release({ log: () => {} });
    const out = await child(hold(0)).done;
    assert.equal(out, "WON");
  });

  await check("six processes racing for a free slot: exactly one wins", async () => {
    await wipe();
    const runs = Array.from({ length: 6 }, () => child(hold(6000)));
    const outs = await Promise.all(runs.map((r) => r.done));
    const won = outs.filter((o) => o === "WON").length;
    const busy = outs.filter((o) => o.startsWith("BUSY")).length;
    assert.deepEqual([won, busy], [1, 5], outs.join(" | "));
  });

  await check("an expired lease is taken over", async () => {
    await wipe();
    const dead = { id: "dead", holder: "nobody@nowhere", pid: 1, purpose: "crashed", startedAt: "2020-01-01T00:00:00Z", expiresAt: "2020-01-01T01:00:00Z" };
    const f = join(tmpdir(), `${KEY.split("/").pop()}`);
    writeFileSync(f, JSON.stringify(dead));
    aws("put-object", "--body", f);
    rmSync(f);
    await slot.acquire({ purpose: "check", log: () => {} });
    assert.equal((await slot.read()).lease.pid, process.pid);
  });

  // The two ways a holder finds out its lease was taken: release() called directly, and assertHeld()
  // (what destroy() calls). assertHeld clears the in-memory lease, so each needs its own takeover.
  const takenFromUs = () => child(`await slot.acquire({ force: true, waitMs: 0, log: () => {} }); console.log("TOOK");`).done;
  await check("release() leaves a lease alone that was taken over from us", async () => {
    await wipe();
    await slot.acquire({ purpose: "check", log: () => {} });
    await takenFromUs();
    const before = (await slot.read()).lease.id;
    await slot.release({ log: () => {} });
    assert.equal((await slot.read())?.lease.id, before, "release() deleted a lease that was not ours");
  });
  await check("assertHeld() throws once the lease was taken over from us", async () => {
    await wipe();
    await slot.acquire({ purpose: "check", log: () => {} });
    await slot.assertHeld(); // control: still ours, so it passes
    await takenFromUs();
    await assert.rejects(slot.assertHeld(), /no longer holds the EC2 slot/);
  });

  await check("a waiter gets the slot when the holder releases", async () => {
    await wipe();
    const holder = child(`await slot.acquire({ waitMs: 0, log: () => {} }); console.log("HELD"); await new Promise(r => setTimeout(r, 4000)); await slot.release({ log: () => {} }); console.log("RELEASED");`);
    await new Promise((r) => setTimeout(r, 2500));
    const t0 = Date.now();
    await slot.acquire({ waitMs: 30_000, pollMs: 500, log: () => {} });
    assert.ok(Date.now() - t0 >= 500, "did not wait");
    assert.equal((await slot.read()).lease.pid, process.pid);
    await slot.release({ log: () => {} });
    await holder.done;
  });

  await check("ec2.apply and ec2.destroy refuse a busy slot without touching terraform", async () => {
    await wipe();
    const holder = child(hold(15_000));
    await new Promise((r) => setTimeout(r, 3500));
    const t0 = Date.now();
    await assert.rejects(ec2.apply({ bare: true, os: "ubuntu" }), (e) => e.code === "SLOT_BUSY");
    await assert.rejects(ec2.destroy(), (e) => e.code === "SLOT_BUSY");
    assert.ok(Date.now() - t0 < 20_000, "took long enough to have run terraform");
    holder.kill();
    await holder.done;
  });
} finally {
  try { aws("delete-object"); } catch {}
}
console.log(failed ? `\n${failed} check(s) failed` : "\nall checks passed");
process.exit(failed ? 1 : 0);
