# doc-tester

Walks documented procedures against a real (or forked/provisioned) target — Tiger Cloud Console today, an EC2-hosted self-hosted TimescaleDB target as of this plan — and produces a pass/fail report.

## Language

**docs-tester**:
The AWS IAM user this tool uses to provision and tear down its own AWS infrastructure, reached through the AWS CLI profile `DOCTEST_AWS_PROFILE` names (`docs-tester` by default; none on a machine that authenticates with a role). Distinct from any admin AWS identity used to bootstrap resources docs-tester itself can't create.
_Avoid_: admin profile, the AWS account.

**The AWS account**:
The AWS account where this tool's EC2 infrastructure lives. Its number is part of `DOCTEST_TFSTATE_BUCKET` and is never written in git.

**The EC2 target**:
The throwaway EC2 instance, provisioned by Terraform with TimescaleDB pre-installed via cloud-init, that self-hosted docs pages run SQL procedures against — the self-hosted analog of a forked Tiger Cloud service. Its install-it-yourself counterpart is the bare target.
_Avoid_: the box (fine informally, not canonical), self-hosted service (confusable with Tiger Cloud's standing services).

**Ad hoc lifecycle**:
Infrastructure created on demand for a session and destroyed afterward via explicit up/down steps, as opposed to a standing service kept running continuously.
_Avoid_: ephemeral, throwaway (used loosely elsewhere).

**The slot**:
The single place the EC2 target can live: one Terraform state, one instance. Only one run holds it at a time, through the slot lease. A second run waits, then is refused, and never touches the holder's box.
_Avoid_: the lock (the project lock is a different thing, about the Console).

**The slot lease**:
The record in the tfstate bucket that says which run holds the slot, since when, and until when. It expires on its own if its holder dies, and `node scripts/slot.mjs down --force` ends it early.
_Avoid_: the lock.

**The SSM tunnel**:
A local port-forward opened via AWS Systems Manager Session Manager (`aws ssm start-session --document-name AWS-StartPortForwardingSession`) that reaches the EC2 target's Postgres port without any public inbound security group rule.
_Avoid_: the connection, port forward (too generic).

**The tfstate bucket**:
The S3 bucket holding this tool's Terraform state. Created once, out-of-band, before any `terraform init`/`apply` runs — never created or deleted by Terraform itself or by docs-tester.
_Avoid_: the state bucket.

**Bare target**:
An EC2 target with only the OS (plus the walker's own harness: the pty driver's python3, and an SSM agent on an AMI that ships none) and the prerequisites its plan declares, standing in for a reader's fresh machine. Commands run as the AMI's default non-root user, so the guide is what installs the database. A distro plan declares no prerequisites, so its box really is bare.
_Avoid_: clean box, empty instance, fresh target.

**Prerequisite**:
A tool or service the guide says you need before its first step and does not script, such as Docker, `psql`, or a Kubernetes cluster. The harness provides it, and only when the plan declares it, so a guide that forgets to install something a distro reader needs still fails. The report lists what was provided. A cluster counts as provided when the reader's `kubectl` can reach it: the guide's "a cluster" and "kubectl" are one prerequisite, so the connection between them (the kubeconfig) comes with it. Something the guide leaves out of its steps that a reader must *do* (create the folder a bind mount points at) is not a prerequisite but a guide gap: the plan runs the guide as written and goes red.
_Avoid_: dependency, setup step (a plan step is a command the page gives).

**Install-guide run**:
A run where the walker follows a docs install guide's commands verbatim on a bare target, answering the guide's prompts as a reader would.
_Avoid_: Phase B (the retired roadmap label for this), install testing (too broad — cloud-init also "follows" the guide without the walker driving it).

**The reader's path**:
The part of a real install page a reader sees after choosing their tabs, such as Linux and then Ubuntu, including the shared steps that follow the tabs. It is the whole of what a bare plan is checked against, and nothing a reader on another tab sees counts.
_Avoid_: the page (it holds every distro's guide at once), the partial (the shared steps live outside the distro's own partial).

**Guide command**:
One command a reader runs, as the install page gives it, in the reader's path. A bare plan has to run every guide command or declare that it skips it, and may run nothing the page does not give.
_Avoid_: statement (the Console check's word for SQL and client commands only).

**Target**:
A product a plan runs on, named in the plan's `target:` line and in a step prefix: `cloud` or `self-hosted` (docs/adr/0006). `fork the service` is a separate concept — a throwaway copy of each target, a fork on Tiger Cloud and a no-op on the EC2 target — and no longer says where a plan runs. The retired phrase `fork the self-hosted service` carried both meanings and is reported by the parser with a pointer at `target:`. Internal code spells the target the way the plan does (`self-hosted`); frontmatter's `self_hosted` is mapped at the edge in `lib/plan.mjs`'s TARGETS.
_Avoid_: fork target (the retired coupling), self-hosted fork, substrate as the author-facing word (the grammar says target).

**Run unit**:
A (target, plan block) pair that a run walks on its own box, serially. A page with an Ubuntu block and a Debian block is two run units. A Docker block and an Ubuntu block can both run on Ubuntu, so a result row is told apart by the box's distro and the reader's path, not the distro alone (docs/adr/0008).
_Avoid_: job, leg.

**The EC2 walker**:
The self-hosted equivalent of the browser walker: runs a plan's `run SQL:` and `run command:` steps against the EC2 target with no Playwright involved at all, since self-hosted pages have no Console UI to drive.
_Avoid_: the SQL walker (undersells it — it runs shell commands too, not just SQL).

**The dev fixture**:
A synthetic, throwaway `<TestPlan>` living inside this repo (not the real docs repo) that the EC2 walker gets built and tested against, reachable via a `DOCS_REPO` override. Never a real docs page, never merged anywhere. The install-guide fixtures are also a staging copy of a plan that belongs in the real guide (docs/adr/0008): their commands are copied by hand, so a green run says the copy works, not that the live guide matches it, and one may carry a labelled workaround for a known guide bug. Only a plan on the real page is evidence about the guide.
_Avoid_: the test plan, the fixture (both too generic in a codebase full of plans and fixtures).
