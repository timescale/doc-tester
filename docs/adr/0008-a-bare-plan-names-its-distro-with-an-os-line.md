---
status: accepted
---

# A bare plan names its distro with an `os:` header line

The install page has six Linux tabs (Debian, Ubuntu, Red Hat, Fedora, Rocky, Arch), and each is its own procedure that needs its own plan on the same page. ADR 0006 makes two blocks claiming the same product a parse error, and `target:` only knows `cloud` and `self-hosted`, so two self-hosted install plans on one page could not be written.

We add a third header line next to `target:` and `machine:` (ADR 0007): `os: ubuntu`. Two rules keep a half-declared plan from passing silently. `os:` is legal only with `machine: bare`, because the pre-installed box is Ubuntu-only and a distro line there would mean nothing. A `machine: bare` plan must name its `os:`, because there is no default to infer (ADR 0004). The one-block-per-product rule becomes **one block per (target, os)**: a pre-installed self-hosted block and a bare one are different pairs, and two bare blocks differ by distro.

A **run unit** is a (target, block) pair. A page with an Ubuntu block and a Debian block runs two serial apply, walk, destroy cycles, each on its own box: ADR 0005's "ad hoc per page" becomes ad hoc per block, and `lib/ec2.mjs`'s single `aws_instance.ec2` and its orphan check stay valid because only one box exists at a time. Results get one row per `(target, os)` (*amended by ADR 0011: a Docker block and a distro block can share a distro, so the key gains the reader's path*); the page passes only if every row that ran passed. `--os` narrows a run to one distro, the way `--products` narrows it to one product, and a block it excludes is reported as "not run", never folded into a pass.

**Where plans live.** *Amended by ADR 0010.* The first version of this ADR put each distro's plan in that distro's own partial. That cannot work for an install-guide run: the install page imports the shared "add the extension" steps once, after the nested distro tabs, so no distro partial contains the steps its plan has to run. A bare plan is now one block per `(target, os)` on the install page itself, and what it is checked against is the reader's path on that page (ADR 0010). The cost is that a plan repeats the guide's commands for each distro, and the fidelity lint is what keeps the copy honest.

**Adding a distro** is a name in `OSES` (`lib/plan.mjs`), its default user in `lib/ec2.mjs`, its AMI in `infra/` (plus a bootstrap if the AMI ships no SSM agent), and a plan. The grammar does not change.

A pre-installed target stays Ubuntu only, enforced by a Terraform precondition (`os` other than `ubuntu` needs `bare = true`).

**Considered and rejected:**

- *Distros as new `target:` values* (`self-hosted-ubuntu`, …). A distro is not a product, and ADR 0006 says a new target is a row, a provisioner and a walker; that would be six near-identical ones.
- *A plan file per distro, selected by a CLI flag.* It sidesteps the parser but moves "where does this run" out of the plan, the inference-by-convention ADR 0004 rejected.

Amends ADR 0006 (one block per product). Related: ADR 0004, 0005, 0007; #88.
