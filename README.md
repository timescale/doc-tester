# doc-tester

Runs the procedures in our docs against a **real** Tiger Cloud service and reports what broke.

Point it at a docs page. If that page carries a `<TestPlan>` block, the tool signs into the Console,
walks the plan step by step (clicking documented labels, running documented SQL), screenshots as it
goes, and writes a pass/fail report. If the page has no plan, nothing runs — that is the design, not
a gap.

Still a proof of concept: one product (Tiger Cloud), one account, on your machine.

## The plan is the gate

A page is testable when, and only when, it has a `<TestPlan>` block. There is no inference step.

This replaced an earlier extractor that read the prose and guessed which parts were procedures. That
guessing is what produced confident, specific, wrong findings, and `extract.mjs` was deleted. A plan
is written by a person who knows what the test needs.

- **Authoritative grammar:** `src/components/TestPlan.astro` in the docs repo. It renders nothing on
  the page; its doc comment is the spec, and it is kept current.
- A plan is **one numbered list** and nothing else. No sections. Unnumbered text is commentary.
- A plan is **not graded against the prose**. It is the same flow written for a bot: same controls,
  plus the mechanical steps a human is never told (dismiss the confirm dialog, collapse the panel
  covering the form).
- A route the tool can't drive gets **no steps** — absence of steps is the skip. Absence of the whole
  block means nobody has written the plan yet, and keeping those apart is what makes coverage
  countable.
- A step matching no verb is **reported**, never silently skipped.

Verbs, in brief: `fork the service`, `select the service`, `go to /path`, `download <url>`,
`upload <file>`, `click`, `click tab|button|link|menuitem`, `toggle`, `type … into`,
`use the row for $VAR`, `choose an unselected option`, `open the first row in the list`, `run SQL:`, `run command:`, `exit psql`,
`replace the statement with:`, `expect rows:`, `expect no rows:`, `expect error:`, `expect url`, `expect label`,
`expect no label`, `expect enabled`, `dismiss`. Read `TestPlan.astro` for the exact forms — don't copy from here.

## Verdicts

| Verdict | Meaning |
| --- | --- |
| **PASS** | every step ran |
| **NEEDS INPUT** | a step needs a value the docs leave open, or targets an unlabeled control |
| **STOPPED EARLY** | a destructive step was deliberately not run (only happens off-fork) |
| **FAIL** | a documented step genuinely failed |
| **NOT TESTABLE** | the page has no `<TestPlan>` |

A page's verdict is the worst of its procedures'. `overallVerdict` in `lib/report.mjs` is the single
definition; the batch runner imports it rather than keeping a second copy.

## Setup

Node ≥ 22, a local `Tiger-Data-Docs` checkout, and the
[Tiger CLI](https://www.tigerdata.com/docs/get-started/quickstart/cli-rest-api).

```bash
npm install
npx playwright install chromium
cp .env.example .env
tiger auth login          # OAuth, stored in the system keyring — no API keys in .env
npm run login             # headless Console login, session saved to .auth/
```

Then fill in `.env` (see [Configuration](#configuration)). `.env` and `.auth/` are git-ignored.

`npm run login` only needs re-running if the session fully expires; a run that gets logged out
mid-walk re-authenticates in place.

## Usage

```bash
npm run test-page  -- "/learn/tiger-cloud/tiger-cloud-essentials"
npm run test-batch -- --section learn
npm run build-report                      # rebuild report.html from the last run, no re-walk
```

A full docs URL works too. The report opens in your browser automatically outside CI.

### `test-page` flags

| Flag | Effect |
| --- | --- |
| `--fail-fast` | stop the walk at the first failure |
| `--keep-fork` | don't delete the fork; prints the id and the command to reuse it |
| `--use-fork <id>` | run against a service you already have. Trusted as given and **never deleted** — a kept fork, or a standing service you want to drive directly |
| `--from <N\|text>` | start at a step |
| `--until <N\|text>` | stop after a step |

`--from`/`--until` take **a number or matching text** (`--from "replace the statement"`), because step
numbers shift the moment someone inserts a step. Step numbering in the report always matches the file,
sliced or not. An inverted or empty range is refused, as is an unknown flag — a silently ignored
`--dry-run` once started a second real run alongside one already in flight.

A slice keeps the `select the service` step that precedes it even when it is out of range: navigation
into the service is a precondition, not a step under test. Without it a mid-page slice sits on the
project's services list and reports every service-scoped control as missing.

### `test-batch` flags

| Flag | Effect |
| --- | --- |
| `--pages <csv\|list>` | specific pages |
| `--section <prefix>` | every page under a section |
| `--all` | every page with a plan |
| `--resume` | continue the most recent batch, skipping pages that reached a verdict (`pass`, `fail`, `blocked`, `stopped`, `skipped`); a page that timed out, crashed, was refused or saved no result runs again, and the run lists them. Refused with exit 2 if `--products` or `--os` differ from the batch's |
| `--products <list>` | only these products of each plan |
| `--os <list>` | only these distros of each bare plan; a page with no such block is listed, never spawned |
| `--dry-run` | print the scope and a rough wall clock (25 min per run, one run per distro block), run nothing |

One child process per page, sequential. Per-page logs plus a `summary.md`. Pages with no plan are
listed, never spawned. A page failing never stops the batch.

### Linting and coverage

```bash
node scripts/lint-plan.mjs "<page url>" [more page urls...]   # one page's plan, no browser or service
```

`lint-plan` reports a line matching no verb, a control the page does not name, a statement drifted
from the page, a procedure or statement no step covers, and steps out of page order.

A `machine: bare` plan on a real page is held to a stricter contract (docs/adr/0010): every command in
its reader's path (the Linux tab, its distro's tab, the shared steps after the tabs) is run or declared
`skip \`<command>\`: <reason>`, and the plan runs nothing the page does not give. `lint-plan` reports it,
and `test-page` checks it before provisioning and exits 2 on drift, so no box is spent on it.
`node scripts/check-guide-lint.mjs` checks the lint against a synthetic page, with no docs checkout and no AWS.
A dev fixture has no guide to match, so it is skipped and says so. The rule is path-based: a `DOCS_REPO`
inside `dev-fixtures/` is fixture mode, and a copy of a fixture kept anywhere else is linted as the real docs
(and refused).

## Configuration

All in `.env`. Nothing in git names a service: a missing value throws on import rather than defaulting
to an id that used to be right.

| Variable | Purpose |
| --- | --- |
| `DOCTEST_PROJECT_ID` | project holding the standing services |
| `DOCTEST_SERVICE_AWS` / `_AZURE` | the standing service per cloud |
| `CONSOLE_EMAIL` / `CONSOLE_PASSWORD` | Console login for the UI walk |
| `DOCTEST_INPUT_*` | values for `$VAR` steps (`$INVITE_EMAIL` → `DOCTEST_INPUT_INVITE_EMAIL`) |
| `DOCS_REPO` | path to the docs checkout |
| `DOCTEST_SHOTS` | `evidence` (default), `doc-update`, or `none` |
| `DOCTEST_STEP_CEILING_MS` | per-step ceiling (default 4 min) |
| `DOCTEST_PAGE_TIMEOUT_MS` | per-page ceiling in a batch (default 45 min) |
| `NO_OPEN=1` | don't open the report (set automatically in a batch) |
| `DOCTEST_EDITOR_BEAT_MS` | pause between the phases of a Monaco write (default 400) |
| `DOCTEST_BUSY_WAIT_MS` | how long to wait for a busy page (an import) before calling a control missing (default 300000) |
| `DOCTEST_SLOT_WAIT_MIN` | how long a self-hosted run waits for another run to release the EC2 slot before refusing (default 15; `0` refuses at once) |
| `DOCTEST_SLOT_TTL_MIN` | how long a run may hold the EC2 slot before its lease can be taken over (default 60) |
| `DOCTEST_LOCK_STALE_MS` | how long a run may go without a heartbeat before its project lock is taken over (default 300000) |
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
  publishes, located by labels unique to their `<NumberedItem>`. For refreshing docs screenshots.
- `none` — the report states outright that its verdict has no visual evidence behind it.

On the essentials page these are roughly 71, 18 and 0 images. Screenshots appear inline under their
step in the report. Archives keep the last 2 runs per page.

## Safety

- **The shared service is never mutated by a destructive plan.** `fork the service` runs the plan on a
  throwaway copy, deleted afterwards along with any read replica sets it created. Without that verb the
  run uses the standing service and refuses every destructive step.
- **Deletion is guarded.** The tool refuses to delete a standing service or anything it didn't create
  this run, and cross-checks the id before deleting a fork. Killing a run still triggers teardown.
- **One run per project at a time.** Every run clears project-level state first, so two runs in one
  project would wipe each other's work and report phantom docs failures. A run takes a lock (a row
  in `doctest.run_lock` on the AWS standing service) before it opens the browser and exits 3 naming
  the holder if someone else has it. A crashed run's lock expires after `DOCTEST_LOCK_STALE_MS`.
- **SQL is gated.** Statements that would mutate a real table are blocked off-fork — including `\COPY`,
  which once slipped the gate and would have ingested 10.7M rows into the standing service.
- **No secrets in the repo.** `.env` and `.auth/` are git-ignored; sensitive values in screenshots are
  blurred. Never write a real address, CIDR or credential into a plan — use a `$VAR`.

## Self-hosted TimescaleDB target

Tiger Cloud Console is the default environment the walker drives. For pages that document
self-hosted TimescaleDB instead, `infra/` provisions a throwaway EC2 instance with TimescaleDB
pre-installed — the self-hosted analog of a forked Tiger Cloud service — and a plan opts into it
with a `target: self-hosted` line before step 1. A plan for a page that documents both products
writes `target: cloud, self-hosted`: shared steps (`run SQL`, `expect …`, `fork the service`,
`download`) run on both, and a step for one side only carries a `[cloud]` or `[self-hosted]` prefix.
The run walks each product in turn and reports one verdict per product; `--products self-hosted`
narrows a run or a batch to one side. A page whose procedures diverge carries one `<TestPlan>` block
per product instead. `test-page`/`test-batch` route by the `target:` line; frontmatter decides
nothing, though a plan claiming a product the page is not tagged with is a parse error, and a page
tagged with a product no block covers is reported as not covered.

A plan that follows an install guide, rather than using a database that is already there, adds
`machine: bare` and an `os: <distro>` line before step 1 (self-hosted only; absent `machine:` means the
pre-installed box above, and `os:` is required with `bare` and illegal without it, docs/adr/0008). A page
writes one block per distro (`ubuntu`, `debian`, `rocky`, `fedora`, `redhat`, `arch`), and a run walks each on its own box, serially; `--os debian`
narrows a run to one. `os:` names the box only. An optional `path:` line (`docker-ha`, `docker-light`, `kubernetes`; legal only with `bare`, docs/adr/0011) names the part of the install page the plan is checked against instead of the distro's own Linux tab, and a block is told apart by distro and path. An optional `needs:` line (`docker`, `psql`, `kubernetes`; legal only with `bare`, and only for the distros the harness can provide it on, docs/adr/0011) names what the guide says you need and does not script: the harness installs it over SSM before step 1, probes it as the box's default user, and the report lists the versions. A distro plan declares nothing, so its box stays bare. ``wait up to 90s for postgres in container `timescaledb` `` (bare only, limit 1 to 600 s) models the seconds a reader spends between `docker run -d` and the next command: it polls `pg_isready` over TCP inside the container, fails at once with the container's own log if it exited or does not exist, and the report says how long it waited; the lint checks that the name is on the reader's path (docs/adr/0011) Two pod forms do the same for Kubernetes: ``wait up to 300s for postgres in pod `timescaledb-0` `` probes `pg_isready` through `kubectl exec` (pod Ready is not postgres up: the guide's StatefulSet has no readiness probe), and ``wait up to 120s for pod `test-pod` ready`` waits for the Ready condition of a pod that runs no postgres. Both fail at once, with the pod's events and log, if the pod is gone or its container has terminated; the lint takes `NAME-N` when `NAME` is on the reader's path, since the page names the StatefulSet and never the pod. `needs: kubernetes` installs k3s, the upstream `kubectl` at the version k3s serves (checksum-verified) and the default user's `~/.kube/config`, and the report lists the versions. ``expect output contains `text` `` checks the transcript of the `run command:` above it (a plain substring; the lint requires the text in a non-shell fence on the reader's path and not typed by the plan), and ``answer `postgres=#` with `<Ctrl-D>` `` ends a psql session the guide never ends (docs/adr/0011). A command that needs several lines, such as a heredoc or a YAML manifest, is `run command:` with its body indented under the step; the lines keep their indentation relative to each other, and the lint compares a heredoc the same way. The lint also reports a page's heredoc whose terminator is not in column 0 (a reader who pastes it gets a command that never ends, whatever the plan's own copy does) and a command in a fence not tagged as shell, such as a `yaml` fence holding `kubectl apply` (docs/adr/0011). The real page carries a Docker HA plan and a Docker light plan, both green since the guide says to create the data folder (#92, docs/adr/0011), and the Kubernetes one is not built (#90). A bare box on an AMI with no SSM agent (Debian, Rocky, Fedora, Red Hat, Arch) also gets a tiny bootstrap that installs only the
agent (`infra/templates/ssm-agent.sh.tpl`). Arch has no AMI of its own: `infra/arch-ami/build.sh` builds one from the
official signed cloud image (an admin runs it once, and again to refresh). The box
then has only the OS, with no cloud-init install and no tunnel until the first SQL step, so the
plan's own steps install the database (docs/adr/0007), as the box's default user, with its commands verbatim.
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

Settled design decisions live in `CONTEXT.md` and `docs/adr/0001`-`0011`: pulling this work ahead of
the roadmap's Phase 7 sequencing, SSM Session Manager port-forwarding instead of any
public inbound port, the `docs-tester` IAM policy's permission boundary, why routing is an explicit
grammar line rather than page frontmatter, why the EC2 target is ad hoc per page rather than a
standing service, how one plan covers more than one product, how an install-guide run executes
the guide verbatim, how a bare plan names its distro, the EC2 slot lease, and how a bare plan is
checked against the real guide.

### One-time setup

- [Terraform](https://developer.hashicorp.com/terraform/install) ≥ 1.10, the
  [AWS CLI](https://docs.aws.amazon.com/cli/latest/userguide/getting-started-install.html), and the
  [Session Manager plugin](https://docs.aws.amazon.com/systems-manager/latest/userguide/session-manager-working-with-install-plugin.html)
  (for the SSM tunnel — there is no public inbound port to connect to instead).
- An AWS CLI profile named `docs-tester` in `~/.aws/config`/`~/.aws/credentials`, using the
  `docs-tester` IAM user's access key. The key is not in this repo: get it from whoever administers the AWS account.
  `DOCTEST_AWS_PROFILE` in `.env` defaults to `docs-tester`; only change it if your local profile is
  named something else.
- The AWS resources the tool creates are named `doc-testing-tool-*`, after the tool's earlier name.
  The IAM policy is scoped to that prefix, so those names stay as they are.
- Confirm it resolves correctly before running anything in `infra/`:
  ```bash
  aws sts get-caller-identity --profile docs-tester   # Account should be the one in DOCTEST_TFSTATE_BUCKET
  ```

### Usage

```bash
./infra/up.sh              # provisions the EC2 target (~2-3 min, mostly cloud-init installing TimescaleDB)
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
  resolve-page.mjs   docs URL -> on-disk MDX (inlines partials, resolves {C.X} constants)
  plan.mjs           parse <TestPlan> into steps and actions (parsePlan)
  walk.mjs           the browser engine: drive the Console, run SQL, screenshot each step
  fork.mjs           fork / delete / list / reach services via the Tiger CLI
  ec2.mjs            provision / connect / destroy the self-hosted EC2 target, via infra/ + SSM
  walk-ec2.mjs       run_sql/run_shell over the SSM tunnel, no browser — the self-hosted walker
  services.mjs       the standing project + services, read from .env
  auth.mjs           headless Console login, session reuse, mid-run re-authentication
  fixtures.mjs       fetch the files a page tells the reader to download; cleaned up after
  reset-project.mjs  project teardown — an accumulated row changes a create-flow's CTA
                     (`Create X` becomes `Create new`) and fakes a label finding
  report.mjs         console summary + screenshots/report.html + overallVerdict
scripts/
  login.mjs          Console login, saves the session
  test-page.mjs      run one page
  test-batch.mjs     run many
  build-report.mjs   rebuild report.html from the last run
  slot.mjs           who holds the EC2 slot; tear down its box safely
  live-check-slot.mjs  checks the slot lease against the real bucket (needs docs-tester credentials)
  check-guide-lint.mjs  checks the bare-plan lint against a synthetic install page (no AWS, no docs checkout)
  check-run-units.mjs   checks which (product, distro) runs a page's plan expands to (no AWS, no docs checkout)
  check-saved-run.mjs   checks the batch only grades from a result its own child saved (no AWS, no docs checkout)
  ec2-smoke-test.mjs standalone infra smoke test (extension + hypertable) — not the same path test-page.mjs walks
infra/
  *.tf               the self-hosted TimescaleDB EC2 target (Terraform)
  up.sh / down.sh     provision / tear down
  tunnel.sh           open the SSM port-forward — the only way in, no public inbound port exists
```

## Contributing

- **Read `TestPlan.astro` first.** Most "the tool can't do X" turns out to be a plan question.
- A new verb goes in three places: the grammar comment in `TestPlan.astro`, the parser in
  `lib/plan.mjs`, and the walker in `lib/walk.mjs`. The lint catches plans using a verb the parser
  doesn't know.
- **Fix a wrong control in the plan, not by reordering a global list.** Making `click` prefer buttons
  globally once cost 13 consecutive failures on one page; `click tab` fixed it in the plan.
- **Look at the screenshots before theorising.** Several long detours here died in one glance at the
  failing step's image. The live log prints step titles only — verdicts are in the report.
- **Pace writes into a code editor, and verify them by polling.** Both are in `writeIntoEditor`; use
  it rather than driving Monaco directly. Firing click/select-all/Delete/insert back-to-back leaves
  the editor's model and whatever the app derives from it out of step, and a single read straight
  after a write reports a full editor as empty because Monaco renders only painted lines.
- **Trust the database over the UI.** A read-back of a virtualized editor can report empty while the
  text is really there; the catalog cannot.
- Verify a fix with a slice (`--use-fork` + `--from`) rather than a full-page run.

## Known limits

- A self-hosted `<TestPlan>` (`target: self-hosted`) runs through `test-page`/`test-batch` like any
  other plan — no browser at all, `lib/ec2.mjs` provisions the EC2 target ad hoc per page and
  `lib/walk-ec2.mjs` runs `run_sql`/`run_shell` steps over the SSM tunnel. MST and third-party tools
  still aren't driven at all.
- Coverage is a handful of pages. 444 docs pages are tagged both `cloud` and `self_hosted`, and
  nearly all of them have no plan yet; `target: cloud, self-hosted` is how one plan covers both
  (docs/adr/0006).
- No CI and no test suite yet.
- Unlabeled controls (icons) and open-ended values report NEEDS INPUT rather than being performed.
