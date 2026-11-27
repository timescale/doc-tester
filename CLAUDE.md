# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A proof-of-concept that takes a Tiger Cloud docs URL, finds the corresponding MDX in a local `Tiger-Data-Docs` checkout, walks every documented procedure against a real (or forked) Tiger Cloud Console service using Playwright, and produces a pass/fail report with screenshots.

## Setup

```bash
npm install
npx playwright install chromium
cp .env.example .env          # fill in CONSOLE_EMAIL + CONSOLE_PASSWORD
tiger auth login              # OAuth; select the project that hosts the standing test service
npm run login                 # headless Console login; saves session to .auth/
```

`npm run login` runs Playwright headlessly (no browser window) and works in CI. Re-run it only
when the server-side session fully expires. `DOCS_REPO` defaults to `~/Timescale/Tiger-Data-Docs`;
override with `DOCS_REPO=/path/to/checkout`.

Prerequisites: Node ≥ 22, the [Tiger CLI](https://www.tigerdata.com/docs/get-started/quickstart/cli-rest-api) on `$PATH`.

## Commands

```bash
npm run test-page -- "https://www.tigerdata.com/docs/<section>/<page>"   # the main thing
npm run build-report                                                        # rebuild report.html from last-run.json (no re-walk)
node scripts/plan-sql.mjs "<url>" | tiger db connect $DOCTEST_SERVICE_AWS -- -q -f -   # verify a plan's SQL in a rolled-back transaction, no browser
npm run login                                                               # re-authenticate if the session expires
NO_OPEN=1 npm run test-page -- "<url>"                                      # skip auto-opening the report (useful in CI)
```

`npm run check` runs every `scripts/check-*.mjs`: the checks that need no AWS, no browser and no real credentials (the `DOCTEST_*` ids in `.env` must be set, to any value). Everything live (a Console walk, an EC2 box) is a manual run against real docs pages.

## Architecture

The pipeline is linear: URL → MDX → plan → walk → report.

**`lib/resolve-page.mjs`** — Maps a docs URL to the on-disk `.mdx` file under `DOCS_REPO/src/content/docs/`, inlines all `import … from '*.mdx'` partial imports recursively (real steps often live in `src/partials/`), and resolves `{C.X}` / `${C.X}` product-name constants from `src/constants.ts`.

**`lib/plan.mjs`** — Parses the page's `<TestPlan>` block(s). A plan is ONE numbered list, no sections, with an optional `target:` line before step 1 naming the products it runs on (`cloud`, `self-hosted`; absent means `cloud`) and `[cloud]`/`[self-hosted]` prefixes on steps that run on one side only — see docs/adr/0006. An optional `machine: bare` line (self-hosted only; absent means the pre-installed box) provisions the EC2 target with only the OS, for an install-guide run that follows the docs' own steps — see docs/adr/0007 — and then needs an `os:` line naming the distro, one block per distro — see docs/adr/0008. A page carries more than one block when its procedures diverge by product. The verb set is fixed (`click`, `toggle`, `type`, `run SQL:`, `expect rows:`, `fork the service`, `download <url>`, `answer \`prompt\` with \`reply\``, `skip <thing>: <reason>`, …) compiled into the actions the walker dispatches. No LLM at run time, and a line matching no verb is reported as `unparsed`, never dropped. The plan is NOT graded against the page's prose — it is the same flow written for a bot. Replaced `lib/extract.mjs`, which inferred steps from prose and was deleted along with the provenance/coverage invariants that were its only remaining purpose.

**`lib/fork.mjs`** — All fork/delete lifecycle via the Tiger CLI (not Playwright). If any procedure on a page is destructive, one throwaway fork is created for the whole page and deleted afterward. The standing services (one per cloud, both Enterprise plan) come from `.env` via `lib/services.mjs`, and `isProtected()` keeps this tool from ever deleting them.

**`lib/walk.mjs`** — Playwright engine. Navigates the Tiger Cloud Console, clicks labeled controls, types values, runs SQL in the Monaco-based SQL editor, takes light+dark screenshots per step (with sensitive values blurred), and returns a structured `{ verdict, actions, shots }` per procedure. Verdicts: `pass`, `fail`, `blocked` (disabled control / icon with no label), `stopped` (destructive step on standing service).

**`lib/report.mjs`** — Builds `screenshots/report.html` and prints the terminal summary from a run result object. The result is also saved to `screenshots/last-run.json` so the report can be regenerated with `npm run build-report`.

**`scripts/test-page.mjs`** — Entry point. Orchestrates the full pipeline: resolve → parse the plan → run its `download` and `fork the service` steps → walk → report. Values a plan names (`type $INVITE_EMAIL into …`) are read from `DOCTEST_INPUT_*`, never prompted for, so a run is unattended.

## Key design decisions

- **No LLM in the step extractor.** Steps are found by docs MDX conventions (`NumberedList`, backtick labels, SQL fences) — deterministic and fast. This is a hard boundary: **determinism governs step extraction.**
- **Forks are per-page, not per-procedure.** If any procedure on a page is destructive, one fork serves the entire page so create/edit/delete chains share state correctly.
- **Playwright is used only for the UI walk.** Fork/delete lifecycle goes through the Tiger CLI to avoid Console-automation flakiness during setup/teardown.
- **Standing service is never mutated.** Destructive steps on the standing service are stopped before execution, not skipped silently.

## Configuration

The standing test project and services live in `.env`, not in code: `DOCTEST_PROJECT_ID`, `DOCTEST_SERVICE_AWS`, `DOCTEST_SERVICE_AZURE`, read by `lib/services.mjs` for the code path that needs them (`requireCloud()` for a Tiger Cloud run; `requireAws()` for the state bucket, called by the slot's first S3 call) and seen by `lib/walk.mjs` and `lib/fork.mjs` through live bindings. One service per cloud, both in an Enterprise-plan project so Enterprise-gated procedures can be forked and exercised for real.

**These are recreated periodically and the IDs change.** That used to mean editing two files and several comments, and a stale id does not fail cleanly — the run points at a service nobody looked at. Now: read the ids from `tiger service list`, change `.env`, done. A missing value stops the run that needs it, by name, rather than falling back to an id that used to be right; the offline checks and the lint need none of them.

`lib/fork.mjs` drives the Tiger CLI via its ambient OAuth session (`tiger auth login`) rather than API keys in `.env`. Console UI credentials (`CONSOLE_EMAIL`/`CONSOLE_PASSWORD`, for `npm run login`) live in `.env` (git-ignored), as do the `DOCTEST_INPUT_*` values a plan names.
