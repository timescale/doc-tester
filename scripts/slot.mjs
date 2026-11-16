#!/usr/bin/env node
// Look at, or break, the EC2 slot's lease (lib/slot.mjs, docs/adr/0009).
//   node scripts/slot.mjs status          who holds the slot, and whether a box is in state
//   node scripts/slot.mjs down            destroy the box in state (waits for no one: refuses if a live run holds the slot)
//   node scripts/slot.mjs down --force    take the slot over from a holder known to be dead, then destroy its box
// infra/down.sh is the raw terraform destroy and ignores the lease: this is the safe way to use it by hand.
import * as slot from "../lib/slot.mjs";
import * as ec2 from "../lib/ec2.mjs";

const [cmd, ...flags] = process.argv.slice(2);
if (cmd === "status") {
  const cur = await slot.read();
  console.log(cur ? `held by ${slot.describe(cur.lease)}${Date.parse(cur.lease.expiresAt) < Date.now() ? "  [EXPIRED: the next run takes it over]" : ""}` : "free");
  const boxes = await ec2.orphanInstances();
  console.log(boxes.length ? `boxes running: ${boxes.map((b) => `${b.id} (since ${b.launched})`).join(", ")}` : "no box running");
} else if (cmd === "down") {
  try {
    await slot.acquire({ purpose: "down", waitMs: 0, force: flags.includes("--force") });
    await ec2.destroy();
    console.log("destroyed; slot free");
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }
} else {
  console.error("usage: node scripts/slot.mjs status | down [--force]");
  process.exit(2);
}
