# doc-tester

Runs the test plans written on Tiger Data documentation pages and reports which documented steps fail.

A docs page carries a `<TestPlan>` block: its procedure written as steps a program can run. This tool runs that plan against a real Tiger Cloud service through Tiger Console, against self-hosted TimescaleDB on a throwaway EC2 box, or both, and writes a pass or fail report. A page with no plan is not tested.

The pages and their plans are in [timescale/Tiger-Data-Docs](https://github.com/timescale/Tiger-Data-Docs). The Tiger Data docs team builds and runs this tool.

## What you need

| To | You need |
|---|---|
| Lint a plan | Node 22 or later, and a checkout of the docs repository |
| Run a plan on Tiger Cloud | also a Tiger Cloud project and the Tiger CLI |
| Run a plan on self-hosted TimescaleDB | also an AWS account, Terraform, the AWS CLI and the Session Manager plugin |

## The plan is the gate

A page is testable when, and only when, it has a `<TestPlan>` block. There is no inference step.

This replaced an earlier extractor that read the prose and guessed which parts were procedures. That
guessing is what produced confident, specific, wrong findings. A plan is written by a person who
knows what the test needs.

- **Authoritative grammar:** `src/components/TestPlan.astro` in the docs repo. It renders nothing on
  the page; its doc comment is the spec. The parser that implements it is `lib/plan.mjs`.
- A plan is **one numbered list**. No sections. The only lines with meaning outside the list are the
  header lines before step 1 (`target:`, `machine:`, `os:`, `path:`, `needs:`). Other unnumbered text
  is commentary.
- A plan is **not graded against the prose**. It is the same flow written for a bot: same controls,
  plus the mechanical steps a human is never told (confirm the dialog, collapse the panel covering
  the form). The lint does check that every control a plan presses is named on the page.
- A route the tool can't drive gets **no steps** — absence of steps is the skip. Absence of the whole
  block means nobody has written the plan yet, and keeping those apart is what makes coverage
  countable. The one exception is an install-guide plan (`machine: bare`), which declares each guide
  command it leaves out with `skip`.
- A step matching no verb is **reported**, never silently skipped.
- A plan that breaks a grammar rule (an unknown product in `target:`, a step prefix the block does
  not cover) does not run: `test-page` exits 2 and names the rule.

Verbs, in brief:

- Where the run happens: `fork the service`, `select the service`, `go to /path`, `open <url>`.
- Files: `download <url>`, `upload <file>`, `paste <file> into the box`, `save the download as <path>`.
- The interface: `click`, `click … > …`, `click … in …`, `click tab|button|link|menuitem`, `confirm`,
  `dismiss`, `toggle`, `type … into`, `type $VAR into`, `type the value the dialog asks for`,
  `use the row for $VAR`, `choose an unselected option`, `select another option in the dropdown`,
  `edit a parameter value`, `open the first row in the list`.
- Data: `run SQL:`, `run command:`, `replace the statement with:`, `exit psql`, and for install-guide
  plans `answer … with …`, `skip …: <reason>` and `wait up to <N>s for …`.
- Assertions: `expect rows:`, `expect no rows:`, `expect error:`, `expect output contains`,
  `expect url`, `expect label`, `expect no label`, `expect enabled`.
- Escape hatch: `[resolve: <hint>]`, for a control the docs cannot name.

Read `TestPlan.astro` for the exact forms — don't copy from here.

Without `fork the service`, a Tiger Cloud run uses a **standing service**: a long-lived test service
in the project, one per cloud (AWS and Azure), that runs read-only steps directly and is forked for
anything destructive. The tool never deletes it and stops before a step that would change it; the
only thing it writes there is its own run lock (see [Safety](#safety)).

## Verdicts

| Verdict | Meaning |
| --- | --- |
| **PASS** | every step ran, and none failed, was blocked or was stopped |
| **NEEDS INPUT** | a step is blocked: it needs a value that is not set, targets an unlabeled control, or the fork or EC2 box the plan asked for could not be made |
| **STOPPED EARLY** | a destructive step was deliberately not run (only happens off-fork) |
| **FAIL** | a documented step failed |
| **NOT TESTABLE** | the page has no `<TestPlan>`, its plan has no steps, or `--products` / `--os` selected nothing the plan covers |

A page's verdict is the worst of its procedures', in the order FAIL, NEEDS INPUT, STOPPED EARLY, PASS.
`overallVerdict` in `lib/report.mjs` is the single definition; the batch runner imports it rather than
keeping a second copy. A plan that covers more than one product also gets one line per product in the
report: its own verdict, `nothing to test` for a block with no steps, `not run` when `--products` or
`--os` left it out, or `not covered` when the page is tagged with a product no block targets.

`test-page` exits 0 on any verdict except FAIL, 1 on FAIL, 2 when it refuses its input (a bad flag, a
plan error, a plan that has drifted from its install guide), and 3 when another run holds the project
or the EC2 slot.

## Setup

Linting needs Node ≥ 22 and a local `Tiger-Data-Docs` checkout, nothing else: `lint-plan` and
`plan-sql` run with no `.env`. The checkout is read from `DOCS_REPO`, which defaults to
`$HOME/Timescale/Tiger-Data-Docs`.

A Tiger Cloud run also needs the [Tiger CLI](https://www.tigerdata.com/docs/get-started/quickstart/tiger-cli),
`psql` and `unzip` on your `PATH`, and a Tiger Cloud project that holds the standing services. Use a
project that exists only for testing: every run clears the project's IP allow lists, private
endpoints and VPC peering entries before and after it walks a page (see [Safety](#safety)).

```bash
npm install
npx playwright install chromium
cp .env.example .env
tiger auth login          # OAuth — no API keys in .env
npm run login             # optional: headless Console login, session saved to .auth/
```

Then fill in `.env` (see [Configuration](#configuration)). `.env` and `.auth/` are git-ignored.

The Console account must sign in with an email and a password; an account that uses SSO cannot log in
headlessly. `npm run login` is optional: a run probes the Console and logs in by itself when the
saved session is missing or dead, and a run that gets logged out mid-walk re-authenticates in place.

A self-hosted run needs the AWS setup in [Self-hosted TimescaleDB target](#self-hosted-timescaledb-target).

## Usage

```bash
npm run test-page  -- "/learn/tiger-cloud/tiger-cloud-essentials"
npm run test-batch -- --section learn
npm run build-report                      # rebuild report.html from the last run, no re-walk
```

A full docs URL works too. The report is `screenshots/report.html`. In an interactive terminal the
tool opens the report and its folder of screenshots when the run ends, unless `NO_OPEN` is set.

### `test-page` flags

| Flag | Effect |
| --- | --- |
| `--fail-fast` | stop the walk at the first failure |
| `--products <list>` | only these products of the plan: `cloud`, `self-hosted`, or both, comma-separated |
| `--os <list>` | only these distros of an install-guide plan (`ubuntu`, `debian`, `rocky`, `fedora`, `redhat`, `arch`) |
| `--keep-fork` | don't delete the fork; prints the id and the command to reuse it |
| `--use-fork <id>` | run against a service you already have. Trusted as given and **never deleted** — a kept fork, or a standing service you want to drive directly. The run is reported as a slice |
| `--from <N\|text>` | start at a step |
| `--until <N\|text>` | stop after a step |

`--from`/`--until` take **a number or matching text** (`--from "replace the statement"`), because step
numbers shift the moment someone inserts a step. Step numbering in the report always matches the file,
sliced or not. An inverted range is refused, as is an unknown flag — a silently ignored `--dry-run`
once started a second real run alongside one already in flight. A slice is for iterating on part of a
plan and is not a page verdict.

A slice keeps the `select the service` step that precedes it even when it is out of range: navigation
into the service is a precondition, not a step under test. Without it a mid-page slice sits on the
project's services list and reports every service-scoped control as missing.

### `test-batch` flags

| Flag | Effect |
| --- | --- |
| `--pages <file>` | the pages listed in a file: one slug or URL per line, `#` comments allowed; in a CSV the first column is used |
| `--section <prefix>` | every page with a plan whose path starts with the prefix (`learn`, `deploy/tiger-cloud`) |
| `--all` | every page with a plan |
| `--resume` | continue the most recent batch, skipping pages that reached a verdict (`pass`, `fail`, `blocked`, `stopped`, `skipped`); a page that timed out, crashed, was refused or saved no result runs again, and the run lists them. Refused with exit 2 if `--products` or `--os` differ from the batch's |
| `--products <list>` | only these products of each plan |
| `--os <list>` | only these distros of each bare plan; a page with no such block is listed, never spawned |
| `--dry-run` | print the scope and a rough wall clock (25 min per run, one run per distro block), run nothing |

One of `--pages`, `--section` or `--all` is required. One child process per page, sequential. Each
batch gets a folder under `screenshots/batches/` with per-page logs, a `state.json` and a
`summary.md`. Pages with no plan, or with a plan error, are listed, never spawned. A page failing
never stops the batch. The batch exits 1 when any page failed or ended without a verdict (a timeout,
a crash, a refusal), and 0 otherwise.

### Linting and coverage

```bash
node scripts/lint-plan.mjs "<page url>" [more page urls...]   # the plans on these pages, no browser or service
node scripts/lint-plan.mjs --all                              # every page that has a plan
node scripts/plan-sql.mjs "<page url>" [--drop <regex>]       # the plan's SQL as a psql script
```

`lint-plan` reports a grammar error, a line matching no verb, a `<TestPlan>` block on a page that
does not import the component, a control the page does not name, a statement drifted from the page,
a procedure or statement no step covers, steps out of page order, and a plan with no assertion. It
exits 1 when it reported anything, 0 when clean, and 2 when given no page. A page-tagged product that
no block targets is listed as advisory and does not change the exit code.

`plan-sql` prints every `run SQL:` step and compiled assertion in plan order, wrapped in a
transaction that rolls back, so the plan's SQL can be piped through `psql` before a walk. `--drop`
leaves out the statements matching a pattern: drop the `INSERT` and the assertion that counts rows
must fail.

A `machine: bare` plan on a real page is held to a stricter contract (docs/adr/0010): every command in
its reader's path (the Linux tab, its distro's tab, the shared steps after the tabs) is run or declared
`skip \`<command>\`: <reason>`, and the plan runs nothing the page does not give. `lint-plan` reports it,
and `test-page` checks it before provisioning and exits 2 on drift, so no box is spent on it.
`node scripts/check-guide-lint.mjs` checks the lint against a synthetic page, with no docs checkout and no AWS.
A dev fixture has no guide to match, so it is skipped and says so. The rule is path-based: a `DOCS_REPO`
inside `dev-fixtures/` is fixture mode, and a copy of a fixture kept anywhere else is linted as the real docs
(and refused).

### Checks

```bash
npm run check
```

Runs the 16 `scripts/check-*.mjs` scripts. They need no AWS, no browser and no secrets, only the four
variables `DOCTEST_PROJECT_ID`, `DOCTEST_SERVICE_AWS`, `DOCTEST_SERVICE_AZURE` and
`DOCTEST_TFSTATE_BUCKET` set to any value. `.github/workflows/checks.yml` runs them on every pull
request and on pushes to `main`, on Node 22 and 24, and scans a pull request's commits for committed
credentials.

## Configuration

Set these in `.env` at the repository root, or in the environment. Nothing in git names a service: a
missing value throws on import rather than defaulting to an id that used to be right.

Required by `test-page`, `test-batch`, `build-report`, `scripts/slot.mjs` and `npm run check`. `lint-plan`,
`plan-sql` and `npm run login` do not read them:

| Variable | Purpose |
| --- | --- |
| `DOCTEST_PROJECT_ID` | project holding the standing services |
| `DOCTEST_SERVICE_AWS` / `_AZURE` | the standing service per cloud |
| `DOCTEST_TFSTATE_BUCKET` | S3 bucket that holds the Terraform state and the EC2 slot lease. A Tiger Cloud-only setup still has to set it, to any value |

Required for a Tiger Cloud run:

| Variable | Purpose |
| --- | --- |
| `CONSOLE_EMAIL` / `CONSOLE_PASSWORD` | Console login for the UI walk |
| `DOCTEST_INPUT_*` | values for `$VAR` steps (`$INVITE_EMAIL` → `DOCTEST_INPUT_INVITE_EMAIL`). A step whose value is not set is reported blocked. `.env.example` lists the ones current plans use |

Optional:

| Variable | Purpose |
| --- | --- |
| `DOCS_REPO` | path to the docs checkout (default `$HOME/Timescale/Tiger-Data-Docs`) |
| `DOCTEST_SHOTS` | `evidence` (default), `doc-update`, or `none` |
| `DOCTEST_STEP_CEILING_MS` | per-step ceiling (default 240000, 4 min) |
| `DOCTEST_PAGE_TIMEOUT_MS` | per-page ceiling in a batch (default 45 min) |
| `NO_OPEN=1` | don't open the report (set automatically in a batch) |
| `DOCTEST_EDITOR_BEAT_MS` | pause between the phases of a Monaco write (default 400) |
| `DOCTEST_BUSY_WAIT_MS` | how long to wait for a busy page (an import) before calling a control missing (default 300000) |
| `DOCTEST_EXPECT_LABEL_WINDOW_MS` | how long `expect label` and `expect no label` keep looking before failing (default 180000) |
| `DOCTEST_FIXTURE_MAX_MB` | size cap on a file a `download` step fetches (default 200) |
| `DOCTEST_LOCK_STALE_MS` | how long a run may go without a heartbeat before its project lock is taken over (default 300000) |
| `DOCTEST_LOCK_HEARTBEAT_MS` | how often a run refreshes its project lock (default 60000) |
| `DOCTEST_AWS_PROFILE` | AWS CLI profile the tool's own `aws` calls use (default `docs-tester`) |
| `DOCTEST_EC2_LOCAL_PORT` | local end of the SSM tunnel to the EC2 box (default 55432) |
| `DOCTEST_SLOT_WAIT_MIN` | how long a self-hosted run waits for another run to release the EC2 slot before refusing (default 15; `0` refuses at once) |
| `DOCTEST_SLOT_TTL_MIN` | how long a run may hold the EC2 slot before its lease can be taken over (default 60) |
| `DOCTEST_IDLE_SECONDS` | how long a command answered with `answer` steps may print nothing before the step fails (default 120) |
| `DOCTEST_HEADED=1` | show the browser instead of running headless |
| `DOCTEST_SLOWMO=<ms>` | pace each action so a person can follow it (use with `DOCTEST_HEADED`) |
| `DEBUG_AUTH`, `DEBUG_CLICKS`, `DEBUG_FULL_ERRORS` | extra tracing |

**The standing services get recreated, and a recreated service gets a new id.** When a run reports
that a service is unreachable, run `tiger service list` and update `.env`. The tool checks
reachability before starting the browser, so this costs one clear sentence rather than a screenful of
phantom "no control labelled X" failures.

### Screenshot modes

- `evidence` (default) — light only, every browser step. What you read a failure from.
- `doc-update` — both themes, retina, and the tool picks its own moments: the images the page already
  publishes inside a procedure. For refreshing docs screenshots.
- `none` — the report states outright that its verdict has no visual evidence behind it.

Screenshots appear inline under their step in the report. Each run is also archived to
`screenshots/archive/`, which keeps the last 2 runs per page. `screenshots/` is git-ignored.

## Safety

- **A destructive plan step never runs on a standing service.** `fork the service` runs the plan on a
  throwaway copy, deleted afterwards along with any read replica sets it created. Without that verb the
  run uses the standing service and stops before a destructive step. Three kinds of step run without
  a fork because a fork would protect nothing: creating a new service, creating a project-level
  resource, and acting on a table row pinned to a value the run owns.
- **Deletion is guarded.** The tool never deletes a standing service, and checks an id's shape before
  deleting anything. It deletes the fork it made, services the plan created, and any other service
  that appeared in the project while the run was in progress, so don't create services by hand in the
  test project during a run. A fork given with `--use-fork` or kept with `--keep-fork` is not deleted.
- **Every run resets the project.** Before and after a Console walk the tool removes the project's
  IP allow lists, private endpoints and VPC peering entries, pending invitations to the addresses
  the plan uses, and client credentials the run created, so a page is graded against an empty
  project. Point the tool only at a project kept for testing.
- **An interrupted run does not clean up.** Ctrl-C releases the project lock and exits; the fork or
  EC2 box of that run stays. The next run lists services that look like leftovers and does not delete
  them: remove them with `tiger service delete <id> --confirm`. `node scripts/slot.mjs down` destroys
  a leftover EC2 box.
- **One run per project at a time.** Every run clears project-level state first, so two runs in one
  project would wipe each other's work and report phantom docs failures. A run takes a lock (a row
  in `doctest.run_lock` on the AWS standing service) before it opens the browser and exits 3 naming
  the holder if someone else has it. A crashed run's lock expires after `DOCTEST_LOCK_STALE_MS`. If
  the lock host cannot be reached, the run warns and continues unlocked.
- **SQL is gated.** Statements that would mutate a real table are blocked off-fork — including `\COPY`,
  which once slipped the gate and would have ingested 10.7M rows into the standing service.
- **Shell commands are limited.** On Tiger Cloud a `run command:` step runs on the machine running
  the test, and only `psql`, `tiger` and `openssl` are allowed. On the self-hosted target a command
  runs on the throwaway box.
- **No secrets in the repo.** `.env` and `.auth/` are git-ignored; sensitive values in screenshots are
  blurred and connection strings and passwords in command output are redacted. Never write a real
  address, CIDR or credential into a plan — use a `$VAR`.

## Self-hosted TimescaleDB target

Tiger Cloud Console is the default environment the walker drives. For pages that document
self-hosted TimescaleDB instead, `infra/` provisions a throwaway EC2 instance with TimescaleDB
pre-installed — the self-hosted analog of a forked Tiger Cloud service — and a plan opts into it
with a `target: self-hosted` line before step 1. A plan for a page that documents both products
writes `target: cloud, self-hosted`: shared steps (`run SQL`, `expect rows`, `expect no rows`,
`expect error`, `fork the service`, `download`) run on both, and a step for one side only carries a
`[cloud]` or `[self-hosted]` prefix.
The run walks each product in turn and reports one verdict per product; `--products self-hosted`
narrows a run or a batch to one side. A page whose procedures diverge carries one `<TestPlan>` block
per product instead. `test-page`/`test-batch` route by the `target:` line; frontmatter decides
nothing, though a plan claiming a product the page is not tagged with is a parse error, and a page
tagged with a product no block covers is reported as not covered.

A self-hosted run uses no browser: `lib/ec2.mjs` provisions the box for the page and destroys it
afterwards, and `lib/walk-ec2.mjs` runs the SQL through an SSM tunnel and the commands through SSM
Run Command.

A plan that follows an install guide, rather than using a database that is already there, adds
`machine: bare` and an `os: <distro>` line before step 1 (self-hosted only; absent `machine:` means the
pre-installed box above, which is Ubuntu, and `os:` is required with `bare` and illegal without it,
docs/adr/0008). A page writes one block per distro (`ubuntu`, `debian`, `rocky`, `fedora`, `redhat`,
`arch`), and a run walks each on its own box, serially; `--os debian` narrows a run to one. `os:`
names the box only.

An optional `path:` line (`docker-ha`, `docker-light`, `kubernetes`; legal only with `bare`,
docs/adr/0011) names the part of the install page the plan is checked against instead of the distro's
own Linux tab, and a block is told apart by distro and path.

An optional `needs:` line (`docker`, `psql`, `kubernetes`; legal only with `bare`, and only on
`ubuntu`, the one distro the harness can provide them on, docs/adr/0011) names what the guide says
you need and does not script: the harness installs it over SSM before step 1, probes it as the box's
default user, and the report lists the versions. A distro plan declares nothing, so its box stays
bare. `needs: kubernetes` installs k3s, the upstream `kubectl` at the version k3s serves
(checksum-verified) and the default user's `~/.kube/config`.

``wait up to 90s for postgres in container `timescaledb` `` (bare only, limit 1 to 600 s) models the
seconds a reader spends between `docker run -d` and the next command: it polls `pg_isready` over TCP
inside the container, fails at once with the container's own log if it exited or does not exist, and
the report says how long it waited; the lint checks that the name is on the reader's path
(docs/adr/0011). Two pod forms do the same for Kubernetes:
``wait up to 300s for postgres in pod `timescaledb-0` `` probes `pg_isready` through `kubectl exec`
(pod Ready is not postgres up: the guide's StatefulSet has no readiness probe), and
``wait up to 120s for pod `test-pod` ready`` waits for the Ready condition of a pod that runs no
postgres. Both fail at once, with the pod's events and log, if the pod is gone or its container has
terminated; the lint takes `NAME-N` when `NAME` is on the reader's path, since the page names the
StatefulSet and never the pod.

``expect output contains `text` `` checks the transcript of the `run command:` above it (a plain
substring; the lint requires the text in a non-shell fence on the reader's path and not typed by the
plan), and ``answer `postgres=#` with `<Ctrl-D>` `` ends a psql session the guide never ends
(docs/adr/0011). A command that needs several lines, such as a heredoc or a YAML manifest, is
`run command:` with its body indented under the step; the lines keep their indentation relative to
each other, and the lint compares a heredoc the same way. The lint also reports a page's heredoc
whose terminator is not in column 0 (a reader who pastes it gets a command that never ends, whatever
the plan's own copy does) and a command in a fence not tagged as shell, such as a `yaml` fence
holding `kubectl apply` (docs/adr/0011).

A bare box on an AMI with no SSM agent (Debian, Rocky, Fedora, Red Hat, Arch) also gets a tiny
bootstrap that installs only the agent (`infra/templates/ssm-agent.sh.tpl`). Arch has no AMI of its
own: `infra/arch-ami/build.sh` builds one from the official signed cloud image (an admin runs it
once, and again to refresh). The box then has only the OS, with no cloud-init install and no tunnel
until the first SQL step, so the plan's own steps install the database (docs/adr/0007), as the box's
default user, with its commands verbatim.
A command that prompts is followed by `answer \`prompt text\` with \`reply\`` steps (`<Enter>` for a bare
Enter, `each time` for a prompt that repeats), which run it on a pty (`lib/pty-driver.py`); a prompt nothing
declared stalls and fails the step. `node scripts/check-pty-driver.mjs` checks the driver without a box.
A bare box is a `bare` Terraform variable,
set by `ec2.apply({ bare: true })`. `dev-fixtures/docs-repo/.../bare-target-dev.mdx` is the smallest dev
fixture for it, and `install-ubuntu-dev.mdx` follows the real Ubuntu install guide:

```bash
NO_OPEN=1 DOCS_REPO="$PWD/dev-fixtures/docs-repo" node scripts/test-page.mjs \
  "https://www.tigerdata.com/docs/self-hosted/bare-target-dev"
```

Settled design decisions live in `CONTEXT.md` and `docs/adr/0001`-`0012`: why the self-hosted work
was done ahead of its planned order, SSM Session Manager port-forwarding instead of any
public inbound port, the `docs-tester` IAM policy's permission boundary, why routing is an explicit
grammar line rather than page frontmatter, why the EC2 target is ad hoc per page rather than a
standing service, how one plan covers more than one product, how an install-guide run executes
the guide verbatim, how a bare plan names its distro, the EC2 slot lease, how a bare plan is
checked against the real guide, how a bare plan names its path and declares its prerequisites, and
how a plan asserts a documented failure with `expect error`.

### One-time setup

- [Terraform](https://developer.hashicorp.com/terraform/install) ≥ 1.17, the
  [AWS CLI](https://docs.aws.amazon.com/cli/latest/userguide/getting-started-install.html), and the
  [Session Manager plugin](https://docs.aws.amazon.com/systems-manager/latest/userguide/session-manager-working-with-install-plugin.html)
  (for the SSM tunnel — there is no public inbound port to connect to instead), plus `psql`.
- An AWS CLI profile named `docs-tester` in `~/.aws/config`/`~/.aws/credentials`, for an IAM user
  with the permissions docs/adr/0003 describes. The profile has to have that name: the Terraform
  backend and provider in `infra/` name it. `DOCTEST_AWS_PROFILE` changes only the profile the tool's
  own `aws` calls use, so leave it at its default.
- An S3 bucket for the Terraform state and the slot lease, named in `DOCTEST_TFSTATE_BUCKET`.
  Terraform does not create it.
- Everything runs in `us-east-1`: the region is fixed in `infra/` and in the tool's `aws` calls.
- The AWS resources the tool creates are named `doc-testing-tool-*`, after the tool's earlier name.
  The IAM policy is scoped to that prefix, so those names stay as they are.
- Confirm it resolves correctly before running anything in `infra/`:
  ```bash
  aws sts get-caller-identity --profile docs-tester   # Account should be the one in DOCTEST_TFSTATE_BUCKET
  ```

### Usage

`test-page` and `test-batch` provision and destroy the box themselves. To stand one up by hand:

```bash
./infra/up.sh              # terraform apply; cloud-init then installs TimescaleDB, which takes a few minutes more
./infra/tunnel.sh          # in a separate terminal — opens the SSM port-forward, leave it running
npm run ec2:smoke-test     # proves it actually works: enables the extension, creates + rolls back a hypertable
./infra/down.sh            # tears it down
```

(`npm run ec2:up` / `ec2:tunnel` / `ec2:down` are equivalent to the `infra/*.sh` scripts above.)

**This is ad hoc, not a standing service, and there is deliberately no TTL auto-teardown.** If you
stand it up, tear it down when you're done — nothing else will.

**One run at a time.** The EC2 target is a single slot, and a run holds it from provisioning to teardown
(docs/adr/0009). A second run waits for it, then refuses with who holds it and exits 3.
`node scripts/slot.mjs status` shows the holder and any running box; `node scripts/slot.mjs down` tears the
box down safely, and `down --force` takes the slot from a holder you know is dead. `infra/up.sh` and
`infra/down.sh` by hand ignore the lease, so check `status` first: a `test-page` run destroys a box that
has no lease as a dead run's leftover.
`node scripts/live-check-slot.mjs` (`npm run check:live`) checks the lease against the real bucket as `docs-tester`, using a throwaway key so the live lease is never touched (it creates no EC2 resources). It needs credentials, so it is not a `check-*.mjs`: those run anywhere, with no AWS, browser or secrets, and are what `npm run check` and CI run.

## Layout

```
lib/
  resolve-page.mjs   docs URL -> on-disk MDX (inlines partials, reads frontmatter, picks the cloud)
  plan.mjs           parse <TestPlan> into steps and actions (parsePlan)
  fidelity.mjs       the lint's checks: a plan against the page it sits on
  guide-report.mjs   how an install-guide finding is worded, shared by lint-plan and test-page
  sql-text.mjs       SQL text helpers shared by the runner and the lint
  slice.mjs          the step slicer behind --from and --until
  walk.mjs           the browser engine: drive the Console, run SQL, screenshot each step
  fork.mjs           fork / delete / list / reach services via the Tiger CLI
  ec2.mjs            provision / connect / destroy the self-hosted EC2 target, via infra/ + SSM
  walk-ec2.mjs       run_sql/run_shell over SSM, no browser — the self-hosted walker
  prerequisites.mjs  installs what a bare plan declares with `needs:`
  wait.mjs           the scripts behind the `wait up to …` steps
  pty-driver.py      runs a command on a pty on the box and types the plan's `answer` replies
  slot.mjs           the EC2 slot lease
  lock.mjs           the one-run-per-project lock
  services.mjs       the standing project + services and the state bucket, read from .env
  auth.mjs           headless Console login, session reuse, mid-run re-authentication
  fixtures.mjs       fetch the files a page tells the reader to download; cleaned up after
  reset-project.mjs  project teardown — an accumulated row changes a create-flow's CTA
                     (`Create X` becomes `Create new`) and fakes a label finding
  batch-resume.mjs   what test-batch --resume may skip, and the batch's exit code
  report.mjs         console summary + screenshots/report.html + overallVerdict
scripts/
  login.mjs          Console login, saves the session
  test-page.mjs      run one page
  test-batch.mjs     run many
  build-report.mjs   rebuild report.html from the last run
  lint-plan.mjs      lint a page's plan, no browser or service
  plan-sql.mjs       print a plan's SQL as a psql script that rolls back
  slot.mjs           who holds the EC2 slot; tear down its box safely
  live-check-slot.mjs  checks the slot lease against the real bucket (needs docs-tester credentials)
  check-*.mjs        the offline checks `npm run check` runs (no AWS, no browser, no docs checkout)
  ec2-smoke-test.mjs standalone infra smoke test (extension + hypertable) — not the same path test-page.mjs walks
infra/
  *.tf               the self-hosted TimescaleDB EC2 target (Terraform)
  up.sh / down.sh     provision / tear down
  tunnel.sh           open the SSM port-forward — the only way in, no public inbound port exists
  templates/          cloud-init for the pre-installed box, and the SSM agent bootstrap for a bare one
  arch-ami/           builds the Arch Linux AMI (an admin runs it)
dev-fixtures/
  docs-repo/          a miniature docs checkout with self-hosted dev pages, for DOCS_REPO
docs/
  adr/                design decisions, 0001 to 0012
.github/workflows/
  checks.yml          runs `npm run check` and a secret scan
CONTEXT.md            the project's vocabulary
```

## Contributing

- **Read `TestPlan.astro` first.** Most "the tool can't do X" turns out to be a plan question.
- A new verb goes in three places: the grammar comment in `TestPlan.astro`, the parser in
  `lib/plan.mjs`, and the walker in `lib/walk.mjs` (`lib/walk-ec2.mjs` for a self-hosted verb). The
  lint catches plans using a verb the parser doesn't know.
- Run `npm run check` before you open a pull request. CI runs the same checks.
- **Fix a wrong control in the plan, not by reordering a global list.** Making `click` prefer buttons
  globally once cost 13 consecutive failures on one page; `click tab` fixed it in the plan.
- **Look at the screenshots before theorising.** Several long detours here died in one glance at the
  failing step's image.
- **Pace writes into a code editor, and verify them by polling.** Both are in `writeIntoEditor`; use
  it rather than driving Monaco directly. Firing click/select-all/Delete/insert back-to-back leaves
  the editor's model and whatever the app derives from it out of step, and a single read straight
  after a write reports a full editor as empty because Monaco renders only painted lines.
- **Trust the database over the UI.** A read-back of a virtualized editor can report empty while the
  text is really there; the catalog cannot.
- Verify a fix with a slice (`--use-fork` + `--from`) rather than a full-page run.

## Known limits

- Two products have a target: Tiger Cloud and self-hosted TimescaleDB. A page tagged with any other
  product, such as MST, is reported as not covered for it.
- Most docs pages have no plan yet. `target: cloud, self-hosted` is how one plan covers both
  products (docs/adr/0006).
- The checks in `npm run check` cover the parser, the lint, the report and the harness scripts.
  Nothing live is tested in CI: a Console walk or an EC2 run is always a manual run.
- The self-hosted target is one box at a time, in one AWS region. The pre-installed box is Ubuntu
  only, and `needs:` is provided on Ubuntu only.
- Unlabeled controls (icons) and values a plan leaves unset report NEEDS INPUT rather than being
  performed.
- `expect rows:`, `expect no rows:` and `expect error:` run inside a `DO` block, so a statement that
  cannot run in a function (`CREATE DATABASE`, `VACUUM`) cannot be asserted with them.
- The Console login is email and password only.

## Reporting a problem

Open an issue in this repository. A problem with a docs page itself belongs in
[timescale/Tiger-Data-Docs](https://github.com/timescale/Tiger-Data-Docs).
