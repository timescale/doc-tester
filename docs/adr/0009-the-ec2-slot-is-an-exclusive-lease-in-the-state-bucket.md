---
status: accepted
---

# The EC2 slot is an exclusive lease in the state bucket

ADR 0005 gives every self-hosted run its own ad hoc box, but all runs share one **slot**: one Terraform state key, one `aws_instance.ec2`. Nothing stopped a second run from starting while the first was still walking. It found the box in state, `apply` did nothing or (once an AMI or `user_data` differs per distro) replaced it, and whichever run finished first destroyed the box under the other. The survivor failed with SSM errors that read like a docs bug. This happened on 2026-10-15, while two people were testing: one run's box was replaced mid-walk, and the cleanup then failed on Terraform's state lock.

Terraform's own lock (`use_lockfile = true`) cannot help: it is held for one terraform command, and the overlap is between commands. The project lock (`lib/lock.mjs`) is about the Console, and fails open when its host is unreachable (it fails closed since EDU-1015).

The slot is now an **exclusive lease**: an object in the tfstate bucket (`doc-testing-tool/ec2/slot.lease.json`), created with a conditional write (`If-None-Match: *`), which S3 makes atomic, and which `docs-tester`'s boundary already allows (ADR 0003). `lib/slot.mjs` owns it. `ec2.apply()` takes the lease before anything else and `ec2.destroy()` releases it, so one run is the only thing touching the slot from provisioning to teardown.

- **A busy slot waits, then refuses.** `apply()` waits up to `DOCTEST_SLOT_WAIT_MIN` (15) for a live holder, saying who it is, then throws `SlotBusyError` before provisioning anything. `test-page` reports the run as not run, destroys nothing (the box in state is the holder's), skips its remaining blocks without waiting again, and exits 3, as a busy project lock does. `DOCTEST_SLOT_WAIT_MIN=0` fails at once.
- **Only the holder destroys.** `destroy()` takes the lease first, or throws if a live run has it, and checks the lease is still its own. A run that outlives its lease (`DOCTEST_SLOT_TTL_MIN`, 60) loses it, and its destroy then leaves the box alone.
- **A box in state when a run gets the lease is a dead run's leftover**, so `apply()` destroys it first instead of reusing it. Reuse used to be the behaviour (`preflight()` returned early when state held an instance), which would hand a bare-target run a machine a previous run had already installed on.
- **No heartbeat.** A holder that dies without releasing blocks the slot until its lease expires. `node scripts/slot.mjs down --force` ends that early by taking the lease over and destroying the box; `slot.mjs status` shows the holder.

**What it does not cover.** The lease is cooperative: it binds the tool's own code. `infra/up.sh` and `infra/down.sh` run by hand ignore it, and so does a checkout that predates it, so every user needs this change before it protects anyone. A box started by hand with `up.sh` has no lease, so a later `test-page` run treats it as a dead run's leftover and destroys it.

**Considered and rejected:**

- *A Terraform workspace per run* (the issue's third option). It would allow parallel runs, but the stack's names are singletons (security group, IAM role and profile, SSM parameter), the SSM permission boundary is conditioned on one instance tag value (ADR 0003), and the orphan check would then flag every other run's box. ADR 0005 chose one slot on purpose; this keeps it.
- *Refuse when state holds an instance, with no lock.* Two runs starting together both see an empty state and both proceed. Only an atomic create closes that, and a six-process race is one of `scripts/live-check-slot.mjs`'s checks.
- *DynamoDB for the lock.* Not in `docs-tester`'s boundary, and S3 conditional writes need nothing new.

Amends ADR 0005 (one slot, now exclusive). Related: ADR 0003, 0008.
