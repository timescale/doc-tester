// The main entry point. Point it at a docs URL; it resolves the rest.
//
//   node scripts/test-page.mjs "https://www.tigerdata.com/docs/.../read-scaling"
//
// What it does:
//   1. finds the page in the local docs repo and reads its real steps (following partials),
//   2. decides whether the page is testable and says why if it isn't,
//   3. reads the values the plan names from DOCTEST_INPUT_* (a run never prompts),
//   4. walks the plan on the live Console, screenshotting each step, or on a throwaway EC2 box
//      for a self-hosted plan,
//   5. writes a PASS/FAIL report (terminal summary + screenshots/report.html).
//
// Console login happens by itself: the run probes the live Console and logs in headlessly with
// CONSOLE_EMAIL/CONSOLE_PASSWORD whenever the saved session is missing or dead. The session is
// saved locally, never committed.

import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { writeFileSync, mkdirSync, copyFileSync, existsSync, readdirSync, rmSync } from "node:fs";
import { spawn } from "node:child_process";
import { join } from "node:path";
import { DOCS_REPO, resolvePage, docImageMoments } from "../lib/resolve-page.mjs";
import { parsePlan, planFor, runUnits, TARGETS, OSES } from "../lib/plan.mjs";
import { provide } from "../lib/prerequisites.mjs";
import { controlsNotNamedOnPage, guideCommandDrift, untaggedFences, isDevFixtureRepo } from "../lib/fidelity.mjs";
import { describeGuideDrift, describeUntagged } from "../lib/guide-report.mjs";
import { prepareFixtures, cleanupFixtures } from "../lib/fixtures.mjs";
import { createSession, walkProcedure, clearShots, listReadReplicasOf, SHOTS, SERVICE_ID, setCloud, PROJECT_ID, SHOTS_DISABLED, testInputEnvVar } from "../lib/walk.mjs";
import { resetProjectSecurity, sweepPendingInvites, listCredentials, sweepCredentials } from "../lib/reset-project.mjs";
import { forkService, deleteService, listServices, waitUntilReady, ensureReachable, STANDING_SERVICE_IDS, runNamePrefix, createdServiceName, partitionArrivals } from "../lib/fork.mjs";
import { buildReport, overallVerdict } from "../lib/report.mjs";
import { acquireRunLock } from "../lib/lock.mjs";
import { requireCloud, requireAws } from "../lib/services.mjs";
import { installStopHandler, stopRequested, stopReason, stoppedLine } from "../lib/stop.mjs";
import * as ec2 from "../lib/ec2.mjs";
import { walkEc2Procedure } from "../lib/walk-ec2.mjs";
import { resolveSlice, applySlice, SliceError } from "../lib/slice.mjs";

// Save the run so the report can be rebuilt (e.g. after a styling change) without re-walking.
const saveRun = (meta, result) => writeFileSync(join(SHOTS, "last-run.json"), JSON.stringify({ meta, result }, null, 2));

// Open the report in the default browser when run interactively (skip in CI/headless, or NO_OPEN=1).
// Hand the run's output to whoever ran it: the report in a browser, and the folder of screenshots in
// the file manager. The folder matters as much as the report — reading a failure means looking at the
// picture next to it, and on this project the screenshots have settled arguments the terminal output
// got wrong. Skipped when not interactive (CI, a piped run) or with NO_OPEN=1.
function reveal(...paths) {
  if (process.env.NO_OPEN || !process.stdout.isTTY) return;
  for (const path of paths) {
    if (!path || !existsSync(path)) continue;
    const [cmd, args] = process.platform === "darwin" ? ["open", [path]]
      : process.platform === "win32" ? ["cmd", ["/c", "start", "", path]]
      : ["xdg-open", [path]];
    try { spawn(cmd, args, { detached: true, stdio: "ignore" }).unref(); } catch { /* best-effort */ }
  }
}
const openReport = (path) => reveal(path);

function slugPrefix(slug) {
  const last = slug.split("/").filter(Boolean).pop() || "page";
  return last.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

async function main() {
  const args = process.argv.slice(2);
  const failFast = args.includes("--fail-fast");
  const val = (name) => {
    const i = args.indexOf(name);
    return i === -1 ? null : args[i + 1];
  };
  // A SLICE, for iterating on one part of a plan. Debugging step 61 of 70 cost eight full runs at 25
  // minutes each today; the fork is 6 minutes of that and the state the late steps need (two tables,
  // a hypertable, 10.7M rows, a reachable wizard) is the rest. So: keep the fork, reuse it, and walk
  // only the steps in question.
  //
  // A slice NEVER produces a page verdict. The report says which steps ran and on which reused fork,
  // because a partial pass read as coverage is the false-green this whole tool exists to prevent.
  // Reject an unknown flag instead of ignoring it. `--dry-run`, which this script does not have, was
  // typed by mistake and silently started a REAL run — a second one, concurrent with a run already in
  // flight, which would have forked a service and fought it over the project reset.
  const KNOWN = new Set(["--fail-fast", "--keep-fork", "--use-fork", "--from", "--until", "--products", "--os"]);
  const takesValue = new Set(["--use-fork", "--from", "--until", "--products", "--os"]);
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (!a.startsWith("--")) continue;
    if (!KNOWN.has(a)) {
      console.error(`\n  unknown option ${a}. Known: ${[...KNOWN].join(", ")}\n`);
      process.exit(2);
    }
    if (takesValue.has(a)) i++; // its value is not a flag and not the url
  }

  const keepFork = args.includes("--keep-fork");
  const useFork = val("--use-fork");
  const url = args.find((a) => !a.startsWith("--") && a !== useFork && a !== val("--from") && a !== val("--until") && a !== val("--products") && a !== val("--os"));
  if (!url) {
    console.error(`Usage: node scripts/test-page.mjs "<docs page URL>" [--fail-fast] [--products cloud,self-hosted] [--os ubuntu]
       slices:  [--keep-fork] [--use-fork <id>] [--from N] [--until N]`);
    process.exit(2);
  }

  // 1. Resolve the URL to real, step-bearing MDX.
  let page;
  try {
    page = resolvePage(url);
  } catch (e) {
    console.error("\n" + e.message + "\n");
    process.exit(2);
  }
  const meta = {
    url,
    file: page.file,
    title: page.frontmatter.title,
    products: page.frontmatter.products || [],
    cloud: page.cloud,
  };
  console.log(`\nPage: ${meta.title || meta.url}\n  ${page.file}\n  Cloud: ${page.cloud}`);

  // 2. The plan is the gate. A page without a <TestPlan> runs nothing: deciding for ourselves which
  // prose is testable is the judgement that produced specific, confident, wrong findings —
  // and a plan is where an author says what a test needs, which reader-facing prose cannot.
  //
  // The plan is not graded against the page's prose. It is the same flow written for a bot: it names
  // the same controls, and spells out the mechanical steps a human would never need told (dismissing
  // a confirmation dialog, for one). A failing step therefore means something on the page is wrong,
  // and the corresponding doc step is easy to find by hand -- which is cheaper and quieter than a
  // comparison that flagged every bot-only step and every legitimately unscripted route.
  const parsed = parsePlan(page.mdx, { products: meta.products });

  // A plan that breaks a grammar rule does not run. The plan as written and the plan as executed
  // would differ, and a report cannot say so for a line it never had. Exit 2, the same as a bad flag:
  // it is the author's input that is wrong, not the page.
  if (parsed.errors.length) {
    console.error(`\n  the <TestPlan> has ${parsed.errors.length} error(s) and cannot run:`);
    for (const e of parsed.errors) console.error(`    ${parsed.plans.length > 1 ? `block ${e.block}` : "plan"}${e.step ? ` step ${e.step}` : ""}: ${e.detail}`);
    console.error(`  See docs/adr/0006 (target and prefix), 0007 (machine) and 0008 (os) for the rules.\n`);
    process.exit(2);
  }

  // Which of the plan's products this run covers. Everything the plan declares, unless --products
  // narrows it (docs/adr/0006): a both-tagged page's verdict should cover what the page claims, and
  // the cost of an EC2 box is paid only by plans that opted into self-hosted. A product the plan does
  // not declare is a skip with a reason, not a failure, so a batch can ask every page for self-hosted
  // and only the pages that cover it run.
  const wanted = val("--products")?.split(",").map((x) => x.trim().toLowerCase()).filter(Boolean) ?? null;
  for (const w of wanted || []) {
    if (!TARGETS.some((t) => t.name === w)) {
      console.error(`\n  --products ${w}: not a product this tool can run on. Known: ${TARGETS.map((t) => t.name).join(", ")}\n`);
      process.exit(2);
    }
  }
  // A run unit is a (target, block) pair (docs/adr/0008): a page with an Ubuntu block and a Debian
  // block is two serial runs on two boxes. `--os` narrows the bare blocks to the distros named, the
  // way `--products` narrows the products; a unit it leaves out is "not run", never a pass.
  const osWanted = val("--os")?.split(",").map((x) => x.trim().toLowerCase()).filter(Boolean) ?? null;
  for (const w of osWanted || []) {
    if (!OSES.includes(w)) {
      console.error(`\n  --os ${w}: not a distro this tool can provision. Known: ${OSES.join(", ")}\n`);
      process.exit(2);
    }
  }
  const { selected, allUnits, units } = runUnits(parsed, wanted, osWanted);
  // The settings a run needs are the ones its targets need (lib/services.mjs): a self-hosted-only run
  // never names a Tiger Cloud service, and a Cloud-only run never names the state bucket. A missing
  // value stops the run here, by name, before anything is provisioned.
  if (selected.includes("cloud")) {
    requireCloud();
    setCloud(page.cloud); // picks the right standing service (lib/walk.mjs) for gotoService/walkProcedure defaults
    console.log(`  standing service: ${STANDING_SERVICE_IDS[page.cloud]}`);
  }
  if (selected.includes("self-hosted")) requireAws();
  const notRun = parsed.targets.filter((t) => !selected.includes(t));
  const osNotRun = allUnits.filter((u) => !units.includes(u));
  const labelOf = (name) => TARGETS.find((t) => t.name === name)?.label ?? name;
  meta.targets = parsed.targets;
  meta.selected = selected;
  // Nothing to walk is a skip with its reason, never a verdict: a run with zero procedures would
  // grade as a pass, which is the false green this tool exists to prevent.
  if (parsed.present && (!selected.length || !units.length)) {
    const notTestable = {
      testable: false,
      reason: !selected.length ? `the plan targets ${parsed.targets.join(", ")}; --products asked for ${wanted.join(", ")}.` : `the plan's blocks are ${allUnits.map((u) => [u.target, u.os].filter(Boolean).join(" on ")).join(", ")}; --os asked for ${osWanted.join(", ")}.`,
      procedures: [], inputs: [],
    };
    saveRun(meta, notTestable);
    openReport(buildReport(meta, notTestable).out);
    process.exit(0);
  }

  // An install-guide run is only evidence about the guide if the plan runs the guide's commands
  // (docs/adr/0010), so a bare plan on a real page is checked against its reader's path BEFORE a box is
  // provisioned: a drifted plan would spend minutes and money on a green that means nothing. Exit 2,
  // like a grammar error: the plan is the author's input, and it is what is wrong.
  const bareUnits = units.filter((u) => u.os);
  if (bareUnits.length) {
    if (isDevFixtureRepo(DOCS_REPO)) {
      console.log(`\n  fixture: guide fidelity not checked (DOCS_REPO is inside dev-fixtures, so the page is not the guide; docs/adr/0010)`);
    } else {
      const found = bareUnits.flatMap((u) => {
        const block = parsed.plans.find((b) => b.index === u.block);
        return guideCommandDrift(page.mdx, block).map((d) => ({ block, d }));
      });
      if (found.length) {
        console.error(`\n  the plan does not match the guide it claims to test, so no box was provisioned (${found.length} finding(s)):`);
        for (const { block, d } of found) {
          const f = describeGuideDrift(d, block, (b, n) => (parsed.plans.length > 1 ? `${b}.${n}` : n));
          console.error(`    ${f.kind}${f.step ? ` (step ${f.step})` : ""}: ${f.detail}\n        -> ${f.fix}`);
        }
        console.error(`\n  A copy of a dev fixture belongs under dev-fixtures/: a DOCS_REPO outside it is treated as the real docs. See docs/adr/0010.\n`);
        process.exit(2);
      }
      // Not refused, but not silent either: a command the lint cannot see is a command the run is not held to.
      for (const u of bareUnits.flatMap((x) => { const block = parsed.plans.find((b) => b.index === x.block); return untaggedFences(page.mdx, block).map((y) => ({ block, y })); })) {
        const f = describeUntagged(u.y, u.block);
        console.log(`\n  warning: ${f.kind}: ${f.detail}\n        -> ${f.fix}`);
      }
    }
  }

  // Prove the service exists BEFORE the browser starts. A stale id is not a loud failure on its own:
  // the walk signs in, lands somewhere plausible, and reports every service-scoped control as
  // missing — findings that read like docs bugs and are not. One check here turns that into one
  // sentence naming the fix. Costs a single `tiger service get` on a path that is about to spend
  // minutes in a browser. Skipped when Cloud is not among the targets this run covers: there is no
  // Tiger Cloud service to check, and a stale DOCTEST_SERVICE_AWS id has nothing to do with it.
  if (selected.includes("cloud")) await ensureReachable(useFork || STANDING_SERVICE_IDS[page.cloud]);

  if (!parsed.present) {
    const notTestable = {
      testable: false,
      reason: "this page has no <TestPlan>, so there is nothing to run. Write one.",
      procedures: [], inputs: [],
    };
    saveRun(meta, notTestable);
    openReport(buildReport(meta, notTestable).out);
    process.exit(0);
  }

  // The images this page publishes inside a procedure. Only used by DOCTEST_SHOTS=doc-update, but
  // printed always: a page whose screenshots no run can locate is worth knowing about.
  const docImages = docImageMoments(page.mdx);
  console.log(`\n  TestPlan: ${parsed.steps.length} step(s)${parsed.plans.length > 1 ? ` in ${parsed.plans.length} blocks` : ""}, targets ${parsed.targets.join(", ")}`);
  if (notRun.length) console.log(`    not run this time (--products): ${notRun.join(", ")}`);
  for (const u of parsed.uncovered) console.log(`    not covered: the page is tagged ${u.product}${u.target ? `, and no block targets ${u.target}` : ", which this tool has no substrate for"}`);
  if (docImages.length) console.log(`    publishes ${docImages.length} in-procedure image(s): ${docImages.map((m) => m.asset.split("/").pop()).join(", ")}`);
  if (parsed.forkRequested) console.log(`    forks a throwaway copy of the service`);
  for (const url of parsed.downloads) console.log(`    downloads ${url}`);
  if (parsed.inputs.length) console.log(`    inputs: ${parsed.inputs.join(", ")}`);
  // Plan/page fidelity: a reader and the bot must press the same controls in the same places. A
  // control the plan clicks that the page never names is either a missing doc step or an invented
  // path, and both make the run's green worth less than it looks. Per block, because step numbers are.
  for (const block of parsed.plans) {
    const drift = controlsNotNamedOnPage(page.mdx, block, DOCS_REPO);
    if (drift.length) {
      console.log(`    \u26a0\ufe0f  ${drift.length} control(s) this plan presses are not named on the page:`);
      for (const d of drift) console.log(`        ${parsed.plans.length > 1 ? `block ${block.index} ` : ""}step ${d.step}: ${d.verb} \`${d.label}\`  — missing doc step, or plan drift`);
    }
  }
  if (parsed.unparsed.length) {
    console.log(`    \u26a0\ufe0f  ${parsed.unparsed.length} line(s) matched no verb and will be reported, not run:`);
    for (const u of parsed.unparsed) console.log(`        ${u}`);
  }

  // A plan with no steps is a deliberate "nothing here is testable" — absence of steps IS the skip.
  // Different from having no plan at all, which just means nobody wrote one. Keeping those two
  // distinguishable is what makes coverage countable.
  if (!parsed.steps.length) {
    const notTestable = {
      testable: false,
      reason: "the page's TestPlan documents no testable steps.",
      procedures: [], inputs: [],
    };
    saveRun(meta, notTestable);
    openReport(buildReport(meta, notTestable).out);
    process.exit(0);
  }

  // One synthetic procedure per target, walked by the existing engines. A plan is linear by design,
  // so there are no variants to merge and no ordering left to infer. Built per target because the
  // steps differ: a `[cloud]` step is a placeholder on the self-hosted walk, kept at its number.
  const testableFor = (plan, target) => {
    let slice;
    try {
      slice = resolveSlice(plan, val("--from"), val("--until"));
    } catch (e) {
      if (!(e instanceof SliceError)) throw e;
      console.error(`\n  ${e.message}\n`);
      process.exit(2);
    }
    const { from, until, inSlice } = slice;
    const sliced = from > 1 || Number.isFinite(until) || !!useFork;

    // A step for another product is reported in place as skipped, with the reason, rather than
    // walked as a step with nothing to do: the Console walker reads an empty step as a control it
    // could not find.
    const other = (s) => ({ action: "noted", did: `for ${s.otherTarget} only; not run on ${labelOf(target)}`, status: "skipped" });
    const testable = [{
      title: `${meta.title || page.slug} (test plan) on ${labelOf(target)}${sliced ? ` — steps ${from} to ${Number.isFinite(until) ? until : plan.steps.length} only` : ""}`,
      target,
      steps: applySlice(plan.steps, inSlice).map((s) => ({
        title: s.text,
        body: s.text, // the walker's structural fallbacks search the body as well as the title
        actions: s.otherTarget && !s.skipOutsideSlice ? [other(s)] : s.actions.filter((a) => a.action !== "unparsed"),
        testInput: s.skipOutsideSlice ? undefined : s.testInput,
        testRow: s.skipOutsideSlice ? undefined : s.testRow,
        skipOutsideSlice: s.skipOutsideSlice,
      })),
    }];
    if (sliced) {
      const n = plan.steps.filter((_, i) => inSlice(i + 1)).length;
      console.log(`  SLICE: walking ${n} of ${plan.steps.length} steps (${from} to ${Number.isFinite(until) ? until : plan.steps.length}). This is for iterating, NOT a page verdict.`);
    }
    return testable;
  };
  console.log(`  ${selected.length} target(s) to walk: ${selected.map(labelOf).join("; ")}`);

  // 3. Ask for any values the page needs (a connection string, host, password, etc.).
  // Values a plan needs are named, never prompted for: walk.mjs resolves each DOCTEST_INPUT_<NAME>
  // from the environment, so a run is unattended and nothing sensitive is written into the docs.
  const inputs = {};

  // Files the plan's `download` steps ask for. Fetched into a throwaway directory that becomes psql's working
  // directory and the source for any `upload` step, and deleted once the walk (either substrate) is
  // done — including when the run fails. Nothing of somebody else's sample data is left on the
  // machine that ran the test. Shared by both substrates: a self-hosted plan can use `download` too.
  let fixtures = { dir: null, files: [], errors: [] };
  if (parsed.downloads.length) {
    console.log(`\nFetching ${parsed.downloads.length} file(s) the page tells the reader to download...`);
    fixtures = await prepareFixtures(parsed.downloads);
    for (const e of fixtures.errors) console.log(`  ⚠️  ${e}`);
    if (fixtures.files.length) console.log(`  ${fixtures.files.length} file(s) ready: ${fixtures.files.join(", ")}`);
  }

  // 4. Walk every testable procedure. If ANY procedure on the page is destructive, fork ONE
  // throwaway copy for the whole page and run every procedure on it in document order (so the
  // create/edit/delete chain shares state), then delete the fork once. Otherwise run on the
  // standing service with destructive steps stopped before.
  const prefix = slugPrefix(page.slug);
  clearShots(prefix); // start clean so the report never picks up a prior run's screenshots
  // A fork isolates a SERVICE. Project-level procedures (Members, Billing, ...) mutate the project,
  // which no service fork can isolate — forking for them would burn several minutes and, worse,
  // stamp "ran on a throwaway fork" on a report whose changes actually landed on the real project.
  // Every service that existed BEFORE this page ran: the baseline for the end-of-run sweep, which
  // looks at what appeared since and deletes the arrivals carrying a name this run issued
  // (lib/fork.mjs partitionArrivals). A service that provisions slowly, so the walk never captured
  // it, is still caught that way; it once leaked a real, billing service. Meaningless for a
  // self-hosted run — no Tiger Cloud service is ever created there — so skip the CLI round-trip.
  const servicesBefore =
    !selected.includes("cloud") ? new Set() : new Set((await listServices().catch(() => [])).map((s) => s.service_id || s.id).filter(Boolean));

  // One run per project. The reset below wipes project-level state, so a second run in the same
  // project would delete what the first is in the middle of testing and the first would report a
  // docs failure that never happened. Taken BEFORE the browser opens, so a run that has to yield
  // costs nothing, and released after the teardown with the rest of it. An interrupted run releases
  // it on its way out too; a run killed harder leaves a row whose heartbeat goes stale and is taken over.
  // A self-hosted-only run touches no Cloud project state and has no lock host to use; its one
  // shared resource, the EC2 slot, is leased by lib/slot.mjs.
  const lock = selected.includes("cloud") ? await acquireRunLock({ page: page.slug || url }) : { acquired: true, skipped: true };
  if (lock.skipped) console.log(`  no project lock: this run does not touch the Tiger Cloud project (the EC2 slot lease serialises self-hosted runs)`);
  if (!lock.acquired) {
    console.error(
      `\n  Another run holds this project: ${lock.holder} is testing "${lock.page}" since ${lock.since}.\n` +
        `  Wait for it to finish, or if that run is dead its lock expires on its own.\n`
    );
    process.exit(3);
  }
  if (lock.open) console.log(`  ⚠️  could not take the project lock (${lock.reason}) — running unlocked; a concurrent run would collide.`);

  // Declared here (shared scope), not inside either branch below: the Report section at the end
  // reads all of these regardless of which substrate ran.
  const results = [];
  const providedByBlock = {}; // what the harness installed for each block's `needs:` (docs/adr/0011)
  let fork = null;
  let forkInfo = null;
  let teardownInfo = null;
  const createdServiceIds = []; // "Create service" makes a standalone resource, unrelated to any fork — track it separately for cleanup
  const createdServiceInfo = [];
  const createdServiceNames = {}; // id -> the name the walk typed for it
  // Every name this run gives a service (lib/fork.mjs): the fork's, and one per service the page's
  // steps create, counted across the page's procedures. The sweep deletes by these exact names.
  const issuedNames = new Set();
  let creations = 0;
  const nameCreated = () => { const n = createdServiceName(prefix, ++creations); issuedNames.add(n); return n; };
  let slotBusy = null; // set when another run holds the EC2 slot (lib/slot.mjs): then no self-hosted block can run, and the exit code says so
  let ec2Live = false; // an EC2 box was applied and not yet destroyed

  // Ctrl-C or SIGTERM: stop after the step in flight and go through the normal teardown below, so
  // the fork, the box and the project state are cleaned up and the report says what ran (lib/stop.mjs).
  // The handler itself exits only on a second signal, naming what that leaves behind.
  installStopHandler({
    onFirst: (sig) => console.error(`\n  ${sig}: stopping after the current step, then cleaning up (fork, EC2 box, project state) and writing the report. Ctrl-C again quits at once without cleanup.`),
    onSecond: () => lock.release?.(),
    leftovers: () => [
      ...(fork?.forkId && !useFork && !forkInfo?.deleted ? [`fork ${fork.forkId}: tiger service delete ${fork.forkId} --confirm`] : []),
      ...createdServiceIds.map((id) => `service ${id}: tiger service delete ${id} --confirm`),
      ...(ec2Live ? ["the EC2 box: node scripts/slot.mjs down"] : []),
      "project-level residue (allow lists, invites, credentials): the next run's pre-run reset removes it",
    ],
  });

  // One walk per target, serial, in TARGETS order: Cloud first, then the EC2 box. A Cloud failure
  // does not skip the self-hosted walk — the two verdicts are independent, and one run should
  // return both findings (docs/adr/0006).
  for (const { target, block, os, path } of units) {
  const plan = planFor(parsed, target, block);
  // A target the interrupt reached before it started is reported, not dropped: the report must say
  // the product was not tested, and `stopped` keeps the page out of a pass.
  if (stopRequested()) {
    console.log(`\n  not run on ${labelOf(target)}: the run was interrupted (${stopReason()})`);
    results.push({ title: `${meta.title || page.slug} (test plan) on ${labelOf(target)}${os ? ` (${[os, path].filter(Boolean).join(", ")})` : ""}`, verdict: "stopped", actions: [stoppedLine(0, "not run")], shots: [], stepTitles: [], target, os, path });
    continue;
  }
  // A block that declares a product and has no steps says "nothing on this page is testable there"
  // (a tab of prose with no procedure, say). That is a verdict of its own, NOT TESTABLE, and it must
  // not cost a fork or an EC2 box: provisioning a target to walk zero steps would spend ten minutes
  // to produce a pass with nothing behind it.
  if (!plan.steps.length) {
    console.log(`\n  nothing testable on ${labelOf(target)}: the block declares the product and has no steps, so nothing is provisioned`);
    results.push({ title: `${meta.title || page.slug} (test plan) on ${labelOf(target)}${os ? ` (${[os, path].filter(Boolean).join(", ")})` : ""}`, verdict: "skipped", actions: [], shots: [], stepTitles: [], target, os, path });
    continue;
  }
  const testable = testableFor(plan, target);
  console.log(`\n  ${testable.map((p) => p.title).join("; ")}`);

  if (target === "self-hosted") {
    // No Console, no Playwright, no Tiger CLI at all for this substrate (docs/adr/0004-0005). Ad
    // hoc per page: provision, walk, destroy, every run. attemptedApply tracks "did we CALL apply",
    // not "did it succeed" — terraform state is incremental, so a resource can exist even if apply()
    // throws partway through, and destroy() must still be attempted regardless of where this failed.
    let attemptedApply = false, tunnel = null, instanceId = null, password = null, provisionError = null;
    // `machine: bare`: only the OS (docs/adr/0007), so there is no cloud-init install to wait for and
    // no Postgres to tunnel to yet. The walker opens the tunnel at the first SQL step instead.
    const bare = plan.machine === "bare";
    console.log(`\nProvisioning the EC2 target (ad hoc for this page${bare ? "; bare, no TimescaleDB installed" : ""})...`);
    try {
      attemptedApply = true;
      // The slot was busy for an earlier block of this page: another run still holds it, so waiting
      // the full timeout again for each remaining block would only repeat the answer.
      if (slotBusy) throw Object.assign(new Error(slotBusy), { code: "SLOT_BUSY" });
      ec2Live = true;
      await ec2.apply({ bare, os: os || "ubuntu" });
      instanceId = await ec2.instanceId();
      await ec2.waitForSsmRegistration(instanceId);
      // What the guide says you need and does not script (docs/adr/0011), installed before step 1 and
      // reported. A failure here is the harness's, so it blocks the run instead of failing a guide step.
      if (bare && plan.needs?.length) providedByBlock[block] = await provide(instanceId, os, plan.needs);
      if (!bare) await ec2.waitForCloudInit(instanceId); // apply() returning means RunInstances succeeded, not that TimescaleDB is installed yet
      if (!bare) tunnel = await ec2.openTunnel(instanceId);
      password = await ec2.dbPassword();
      console.log(`  target ready: ${instanceId}`);
    } catch (e) {
      if (e.code === "SLOT_BUSY") { attemptedApply = false; ec2Live = false; slotBusy = e.message; } // nothing was provisioned, and the box in state is another run's
      // An interrupt during provisioning is not a provisioning failure: the walker below reports every
      // step `stopped`, and the box is destroyed in the finally as it is after a finished walk.
      // Thrown before the lease was taken (a stop, a missing bucket, a profile that does not exist):
      // no box exists, and the box in state is another run's, so there is nothing to destroy.
      if (e.provisioned === false) { attemptedApply = false; ec2Live = false; }
      if (e.code === "STOPPED") console.log(`  ${e.message}`);
      else {
        provisionError = (e.message || "").split("\n")[0];
        console.log(`  ⚠️  provisioning failed: ${provisionError}`);
      }
    }

    // Provisioning has now HAPPENED — the `fork the service` step, if the plan has one, is rewritten
    // into that outcome, the same treatment `fork the service`/`download <url>` get on the Console
    // path below. On this target the verb asks for nothing extra: every EC2 run is a fresh box. A
    // failed provision marks every remaining step blocked too, rather than letting the walker attempt
    // a psql/SSM call against a target that was never actually stood up.
    for (const step of testable[0]?.steps || []) {
      step.actions = step.actions.map((a) => {
        if (a.action === "fork_service") {
          return provisionError
            ? { action: "noted", did: `provisioning the EC2 target failed — ${provisionError}`, status: "blocked" }
            : { action: "noted", did: `provisioned a fresh EC2 target (${instanceId}), which is throwaway by itself; the steps below run on it` };
        }
        return provisionError ? { action: "noted", did: `blocked — provisioning the EC2 target failed`, status: "blocked" } : a;
      });
    }

    // The walk is inside a try so the box is destroyed however the walk ends. A thrown error used to
    // skip the destroy below and leave the box running, the same leak an interrupt caused.
    try {
      for (let i = 0; i < testable.length; i++) {
        const proc = testable[i];
        console.log(`\n— Walking "${proc.title}" (${i + 1}/${testable.length}) on the EC2 target...`);
        const ensureTunnel = async () => (tunnel ??= await ec2.openTunnel(instanceId)).localPort;
        const r = await walkEc2Procedure(proc, { localPort: tunnel?.localPort, ensureTunnel, runAs: bare ? ec2.bareUser(os) : undefined, password, instanceId, inputs });
        r.target = target;
        r.os = os;
        r.path = path;
        results.push(r);
      }
    } finally {
      if (tunnel) ec2.closeTunnel(tunnel);
      const destroyed = attemptedApply
        ? await ec2.destroy().then(() => true).catch((e) => {
            console.log("  ec2 destroy error:", (e.message || "").split("\n")[0]);
            return false;
          })
        : true;
      ec2Live = !destroyed;
      console.log(!attemptedApply ? "\n  Nothing was provisioned, so there is nothing to destroy." : destroyed ? "\n  EC2 target destroyed." : `\n  ⚠️  EC2 target NOT destroyed — run \`node scripts/slot.mjs down\` by hand.`);
      if (results.length) {
        results[results.length - 1].cleanup = !attemptedApply
          ? { status: "ok", did: "nothing was provisioned (the EC2 slot is busy)" }
          : destroyed
            ? { status: "ok", did: "destroyed the EC2 target" }
            : { status: "blocked", did: "EC2 target NOT destroyed — run `node scripts/slot.mjs down` by hand" };
      }
    }
  } else {
  const { browser, page: tab } = await createSession();

  // ALWAYS start from an empty project. The docs describe the empty state of every create-flow: with
  // one list present the button reads `Create new`, with none `Create IP Allow List`. So residue from
  // an earlier run changes the labels this run is graded against, and a correct page reports a
  // missing control.
  //
  // This runs BEFORE the scope probe, not just before the walk: the probe decides scope by how far
  // `Security > IP Allow List > Create IP Allow List` resolves, so a leftover row moves its answer too.
  //
  // Teardown-after cannot cover it alone — a crashed or interrupted run, or one from an earlier
  // session, leaves residue that only a pre-run reset clears.
  console.log(`\nClearing project-level state so this page is graded against an empty project...`);
  const preReset = await resetProjectSecurity(tab, PROJECT_ID).catch((e) => {
    console.log("  pre-run reset error:", (e.message || "").split("\n")[0]);
    return null;
  });
  // The addresses this run owns, from the plan's own inputs — never a hardcoded list, and never an
  // address the plan does not use. An input holding an "@" is an address; the others (a CIDR, a
  // credential name) are not invitations and are left alone.
  const ownedAddresses = [
    ...new Set(
      (parsed.inputs || [])
        .map((n) => (process.env[testInputEnvVar(n)] || "").trim())
        .filter((v) => v.includes("@"))
    ),
  ];
  const preInvites = await sweepPendingInvites(tab, PROJECT_ID, ownedAddresses).catch((e) => {
    console.log("  pending-invite sweep error:", (e.message || "").split("\n")[0]);
    return [];
  });
  for (const inv of preInvites) {
    if (inv.state !== "absent") console.log(`  pending invite ${inv.address}: ${inv.state}`);
  }
  // Client credentials: record the table now, so the post-run sweep can tell a credential this run
  // created (fork-services' `Create credentials` step) from one that was already there. The plan's
  // own credential input, if it has one, is owned by name as well.
  const ownedCredentialNames = (parsed.inputs || [])
    .filter((n) => /CREDENTIAL/i.test(n))
    .map((n) => (process.env[testInputEnvVar(n)] || "").trim())
    .filter(Boolean);
  const credentialBaseline = await listCredentials(tab, PROJECT_ID).catch((e) => {
    console.log("  credential listing error:", (e.message || "").split("\n")[0]);
    return null;
  });
  if (credentialBaseline === null) console.log("  ⚠️  could not read the project's client credentials — the post-run sweep will only remove ones named by the plan");
  const preCredentials = await sweepCredentials(tab, PROJECT_ID, { baseline: credentialBaseline, ownedNames: ownedCredentialNames }).catch((e) => {
    console.log("  credential sweep error:", (e.message || "").split("\n")[0]);
    return [];
  });
  for (const c of preCredentials) console.log(`  credential ${c.name}: ${c.state}`);
  const preRemoved = (preReset || []).reduce((n, t) => n + (t.rows || []).filter((r) => r.did).length, 0)
    + preInvites.filter((i) => i.state === "removed").length;
  // A tab that could not be OPENED carries an `error` and no rows. Printing only rows is how a sweep
  // that never saw the project got reported as "project already empty": an ip-allow-list run then
  // walked against the previous run's leftover allow list, its create steps failed, and its
  // `expect label` passed on the residue.
  const blindTabs = (preReset || []).filter((t) => t.error);
  for (const t of blindTabs) console.log(`  ⚠️  ${t.tab}: could not be read — ${t.error}`);
  for (const tabEntry of preReset || []) {
    const acted = (tabEntry.rows || []).filter((r) => r.did).length;
    const stuck = (tabEntry.rows || []).filter((r) => r.skipped);
    if (acted || stuck.length) console.log(`  ${tabEntry.tab}: ${acted} removed, ${tabEntry.remaining ?? "?"} remaining`);
    for (const s of stuck) console.log(`      ⚠️  left in place — ${s.skipped}  (this page is graded against a DIRTY project)`);
  }
  console.log(
    blindTabs.length
      ? `  ⚠️  ${blindTabs.length} tab(s) could not be read, so this page is graded against a project of UNKNOWN state.`
      : preRemoved
        ? `  ⚠️  removed ${preRemoved} leftover resource(s) — an earlier run did not clean up after itself.`
        : `  project already empty.`
  );

  // Name services that look like leftovers from an earlier run. The teardown sweep at the end of a run
  // lists services at that moment, so a service that MATERIALISES AFTER teardown is invisible to it —
  // what happened once: db-58210 was stamped 12:42Z, three minutes after the run that
  // could have created it had already exited and closed its browser. It billed unnoticed until a manual
  // `tiger service list`, which is why that check is in the 08-03 notes.
  //
  // Reported, never auto-deleted. These are real services in a real project, and a name heuristic is
  // not good enough grounds to destroy one: `db-<digits>` is the Console wizard's default name, so a
  // service a human made by clicking through the wizard looks identical to one a run abandoned.
  const LEFTOVER_NAME = /^(?:db-\d+|doctest-)/i;
  const suspects = (await listServices().catch(() => []))
    .filter((s) => LEFTOVER_NAME.test(s.name || "") && !Object.values(STANDING_SERVICE_IDS).includes(s.service_id || s.id));
  if (suspects.length) {
    console.log(
      `\n  ⚠️  ${suspects.length} service(s) look like leftovers from an earlier run — NOT deleted, check and remove by hand:`
    );
    for (const s of suspects) {
      console.log(`        ${s.service_id || s.id}  ${s.name}  created ${s.created || "?"}`);
      console.log(`          tiger service delete ${s.service_id || s.id} --confirm`);
    }
  }

  // Isolation is DECLARED, not inferred. Verb-sniffing got this wrong in both directions: "Enable
  // tiered storage" reads as harmless and is a service-level change, while one incidental "create" in
  // a label forced a read-only page onto a fork. The author of the plan knows which it is.
  //
  // Declared as a STEP now (`fork the service`), not as an Isolation heading. A plan that says
  // nothing runs on the standing service, where destructive steps are refused anyway — so silence is
  // the safe default rather than a guess, and a project-level page needs no keyword at all: no fork
  // can isolate a project, and not forking is what happens without the step.
  const pageNeedsFork = plan.forkRequested;
  console.log(
    pageNeedsFork
      ? `\n  Isolation: the plan asks for a throwaway fork.`
      : `\n  Isolation: the standing service, with destructive steps stopped before they run.`
  );

  try {
    if (useFork) {
      // Trusted as given: it is a service the person running this made with --keep-fork moments ago.
      // Reachability is checked by the first step that touches it, which fails loudly.
      fork = { forkId: useFork, fork: { service_id: useFork } };
      console.log(`\nReusing fork ${useFork} (given with --use-fork; it will NOT be deleted).`);
    } else if (pageNeedsFork) {
      console.log(`\nThis page has destructive procedures → forking one throwaway copy for the whole page (via the Tiger CLI)...`);
      try {
        issuedNames.add(runNamePrefix(prefix));
        fork = await forkService(STANDING_SERVICE_IDS[page.cloud], { name: runNamePrefix(prefix) });
        console.log(`  fork ready: ${fork.forkId}`);
      } catch (e) {
        const detail = (e.stderr || "").trim() || (e.message || "").split("\n")[0];
        console.log(`  ⚠️  fork failed; falling back to the standing service with destructive steps stopped before.\n  Error: ${detail}`);
        fork = null;
      }
    }
    // The `fork the service` and `download <url>` steps have now HAPPENED — both have to, before the
    // walk has a service to drive or a file to upload. Rewrite them into their outcome so the report
    // shows them in place, numbered with everything else, instead of as preamble the reader has to
    // trust. This is why they are steps at all: a moved dataset or a failed fork is reported against
    // the line that asked for it.
    //
    // A failed fork is `blocked`, not `fail`: the plan asked for isolation and did not get it, which
    // is an infrastructure problem, and reporting it as a failure would read as a docs bug. A failed
    // download IS a `fail` — a dead link in a documented step is a reader-visible docs bug.
    for (const step of testable[0]?.steps || []) {
      step.actions = step.actions.map((a) => {
        if (a.action === "fork_service") {
          return fork
            ? { action: "noted", did: `forked the standing service to ${fork.forkId}; the steps below run on it` }
            : { action: "noted", did: "the plan asked for a fork and none was made; destructive steps below are refused", status: "blocked" };
        }
        if (a.action === "download") {
          const failed = fixtures.errors.find((e) => e.includes(a.url));
          return failed
            ? { action: "noted", did: `downloading ${a.url} failed — ${failed}`, status: "fail" }
            : { action: "noted", did: `downloaded ${a.url} → ${fixtures.files.join(", ") || "no files"}`, };
        }
        return a;
      });
    }

    // The TARGET service for the steps that follow. Not a constant: when a procedure creates a
    // service, that service becomes the target, because the docs go on to talk about it ("run this
    // query on your new service"). Adopting it is what makes the documented flow — create, use,
    // delete — the flow that actually gets tested.
    let serviceId = fork ? fork.forkId : SERVICE_ID;
    // Destructive steps are allowed on a fork, and equally on a service this page created itself:
    // both are throwaways deleted at the end of the run. What must never be mutated is the standing
    // service.
    let allowDestructive = !!fork;
    // Does this RUN own the target service? A fork and a page-created service are both
    // throwaways, so the tool may rotate their password to get a live connection for a
    // documented psql command. The standing services are never rotated behind the user's back.
    let ownTarget = !!fork;

    let pendingCreate = false; // carries "still waiting to confirm a created resource is ready" across procedures on this same fork
    for (let i = 0; i < testable.length; i++) {
      const proc = testable[i];
      if (stopRequested()) {
        results.push({ title: proc.title, verdict: "stopped", actions: [stoppedLine(0, "not run")], shots: [], stepTitles: proc.steps.map((s) => s.title || ""), target });
        continue;
      }
      const where = fork ? "fork " + fork.forkId : serviceId !== SERVICE_ID ? `the service this page created (${serviceId})` : "the standing service";
      console.log(`\n— Walking "${proc.title}" (${i + 1}/${testable.length}) on ${where}...`);
      // Screenshots carry the target in their name, so a Cloud failure and a self-hosted failure on
      // the same page never share a file prefix.
      const r = await walkProcedure(tab, proc, `${prefix}-${target}-p${i}`, { inputs, serviceId, allowDestructive, pendingCreate, serviceOwned: ownTarget, fixturesDir: fixtures.dir, failFast, docImages, nameCreated });
      r.target = target;
      pendingCreate = r.pendingCreate;
      if (fork) r.ranOnFork = fork.forkId;
      if (r.createdServiceId) {
        createdServiceIds.push(r.createdServiceId);
        createdServiceNames[r.createdServiceId] = r.createdServiceName || null;
        // Adopt the service this procedure just created as the target for everything after it. The
        // docs' own narrative depends on it: "create a service" then "run this query" means run it on
        // THAT service. It must be READY first, or the SQL fails on a provisioning database and the
        // report blames the docs.
        if (!fork) {
          console.log(`  waiting for the new service ${r.createdServiceId} to be READY before the next procedure uses it...`);
          const ready = await waitUntilReady(r.createdServiceId);
          if (ready.ok) {
            serviceId = r.createdServiceId;
            allowDestructive = true; // it is a throwaway, deleted at the end of this run
            ownTarget = true;
            console.log(`  now testing against ${serviceId}, the service this page created.`);
          } else {
            console.log(`  ⚠️  ${r.createdServiceId} is still ${ready.status || "not READY"} — later steps keep the previous target (${serviceId}).`);
          }
        }
      }
      results.push(r);
    }
  } finally {
    if (fork?.forkId && (keepFork || useFork)) {
      // Kept on purpose, and a kept fork is a live, billing service until someone removes it — so say
      // so at the end of every run that keeps one, with the command to reuse it and the command to
      // delete it.
      console.log(`\n  fork ${fork.forkId} KEPT (--keep-fork). Reuse it:\n      node scripts/test-page.mjs "${url}" --use-fork ${fork.forkId} --from <N>\n  Delete it when done:\n      tiger service delete ${fork.forkId} --confirm`);
      forkInfo = { id: fork.forkId, deleted: false, kept: true };
    } else if (fork?.forkId) {
      console.log(`\nDeleting fork ${fork.forkId} (via the Tiger CLI)...`);
      // The CLI can't list standby replicas, and they don't appear on the Console's main services
      // list either — only on this specific service's own Read scaling sub-page.
      const gone = await deleteService(fork.forkId, { discoverChildren: () => listReadReplicasOf(tab, fork.forkId) })
        .catch((e) => { console.log("  delete error:", (e.message || "").split("\n")[0]); return false; });
      console.log(gone ? "  fork deleted." : `  ⚠️  fork ${fork.forkId} NOT deleted — remove it with: tiger service delete ${fork.forkId} --confirm`);
      forkInfo = { id: fork.forkId, deleted: gone };
    }
    for (const id of createdServiceIds) {
      console.log(`\nDeleting service ${id} created by the "Create service" walk (via the Tiger CLI)...`);
      const gone = await deleteService(id, { discoverChildren: () => listReadReplicasOf(tab, id) })
        .catch((e) => { console.log("  delete error:", (e.message || "").split("\n")[0]); return false; });
      console.log(gone ? "  deleted." : `  ⚠️  service ${id} NOT deleted — remove it with: tiger service delete ${id} --confirm`);
      createdServiceInfo.push({ id, name: createdServiceNames[id] || null, deleted: gone });
    }
    // Safety net: anything that appeared during this page, still here, and carrying one of the names
    // this run issued (lib/fork.mjs). Catches a service the walk named but never captured, one that
    // only materialised in the list after the walk moved on. A service that appeared under any OTHER
    // name is somebody else's as far as this run can tell: a person creating one by hand in the same
    // project at the same moment looks identical in a list diff, and this used to delete it
    // (EDU-1068). It is listed with the command that removes it, and the report says so.
    // deleteService refuses the standing services, so they can't be caught by this either way.
    const { mine: strays, others } = partitionArrivals(servicesBefore, await listServices().catch(() => []), issuedNames, { exclude: [fork?.forkId, ...createdServiceIds] });
    for (const s of strays) {
      const id = s.service_id || s.id;
      console.log(`\n⚠️  service ${id} (${s.name}) is this run's and was never tracked — deleting it (via the Tiger CLI)...`);
      const gone = await deleteService(id, { discoverChildren: () => listReadReplicasOf(tab, id) })
        .catch((e) => { console.log("  delete error:", (e.message || "").split("\n")[0]); return false; });
      console.log(gone ? "  deleted." : `  ⚠️  service ${id} NOT deleted — remove it with: tiger service delete ${id} --confirm`);
      createdServiceInfo.push({ id, name: s.name, deleted: gone, untracked: true });
    }
    for (const s of others) {
      const id = s.service_id || s.id;
      console.log(`\n⚠️  service ${id} (${s.name || "unnamed"}) appeared in the project during this run without this run's name — NOT deleted. If it is a leftover: tiger service delete ${id} --confirm`);
      createdServiceInfo.push({ id, name: s.name, deleted: false, untracked: true, left: true });
    }
    // Project-level resources a fork cannot isolate (IP allow lists, VPCs, private endpoints). The
    // docs describe the EMPTY state of every create-flow, so rows left behind by one run change the
    // UI the next run is graded against — that is how a correct page gets reported as wrong.
    //
    // Runs whether or not this page forked. It used to be skipped when a fork existed, which
    // contradicts the sentence above it: a fork is a new service INSIDE the same project, so it
    // absorbs service-level changes and takes them with it when it is deleted, while project-level
    // rows outlive it untouched. The ip-allow-list plan proved it — the plan forks, and its
    // `IP-Allow-list-49353` holding the test CIDR was still in the project after the run, waiting to
    // change the UI the next run is graded against.
    //
    // It was also once skipped when the page documented its own teardown, on the theory that the
    // docs' delete was under test and ours would leave it nothing to delete. A plan makes that moot:
    // a plan that wants the page's own teardown exercised includes those steps, and this sweep then
    // finds nothing to do.
    {
      console.log(`\nSweeping project-level security resources...`);
      const reset = await resetProjectSecurity(tab, PROJECT_ID).catch((e) => {
        console.log("  teardown error:", (e.message || "").split("\n")[0]);
        return null;
      });
      for (const t of (reset || []).filter((t) => t.error)) console.log(`  ⚠️  ${t.tab}: could not be read — ${t.error}`);
      for (const tabEntry of reset || []) {
        const acted = (tabEntry.rows || []).filter((r) => r.did).length;
        const stuck = (tabEntry.rows || []).filter((r) => r.skipped);
        console.log(`  ${tabEntry.tab}: ${acted} removed, ${tabEntry.remaining ?? "?"} remaining`);
        for (const s of stuck) console.log(`      ⚠️  left in place — ${s.skipped}`);
      }
      const postInvites = await sweepPendingInvites(tab, PROJECT_ID, ownedAddresses).catch((e) => {
        console.log("  pending-invite sweep error:", (e.message || "").split("\n")[0]);
        return [];
      });
      for (const inv of postInvites) {
        if (inv.state !== "absent") console.log(`  pending invite ${inv.address}: ${inv.state}`);
      }
      const postCredentials = await sweepCredentials(tab, PROJECT_ID, { baseline: credentialBaseline, ownedNames: ownedCredentialNames }).catch((e) => {
        console.log("  credential sweep error:", (e.message || "").split("\n")[0]);
        return [];
      });
      for (const c of postCredentials) console.log(`  credential ${c.name}: ${c.state}`);
      teardownInfo = reset;
    }
    await browser.close();
  }
  } // end Console/Playwright branch — see the matching `if` above createSession()
  } // end of the per-target loop

  // Shared by both substrates, regardless of which branch ran or how it exited.
  if (fixtures.dir) {
    const gone = cleanupFixtures(fixtures.dir);
    console.log(gone ? `\nDeleted the downloaded files.` : `\n⚠️  could not delete ${fixtures.dir} — remove it by hand.`);
  }
  await lock.release?.();

  // 5. Report.
  // A verdict with no pictures is a claim. Say so in the report rather than letting a green run look
  // evidenced — the screenshots have been the only thing that diagnosed several failures here.
  const notes = SHOTS_DISABLED
    ? ["screenshots are OFF (DOCTEST_SHOTS=none), so this verdict has no visual evidence behind it"]
    : [];
  if (stopRequested()) notes.push(`the run was interrupted (${stopReason()}): it stopped after the step in flight and cleaned up; the later steps were not run`);
  // One verdict per product. A product the plan declares but this run excluded is "not run"; one the
  // page is tagged with that no block covers is "not covered". Both are stated, never folded into a
  // pass: the page passes only if every target that ran passed (overallVerdict reads the procedures).
  const targets = [
    ...units.map(({ target: t, os, path, block }) => {
      const procs = results.filter((r) => r.target === t && (r.os || null) === os && (r.path || null) === (path || null));
      // overallVerdict grades skipped as pass, which is right for a page and wrong for a product
      // whose only "procedure" was the empty-block marker: that product has nothing to test.
      return { target: t, ...(os ? { os } : {}), ...(path ? { path } : {}), ...(providedByBlock[block] ? { provided: providedByBlock[block] } : {}), verdict: procs.length && procs.every((p) => p.verdict === "skipped") ? "skipped" : overallVerdict({ testable: true, procedures: procs }) };
    }),
    ...notRun.map((t) => ({ target: t, verdict: "not run" })),
    ...osNotRun.map((u) => ({ target: u.target, ...(u.os ? { os: u.os } : {}), ...(u.path ? { path: u.path } : {}), verdict: "not run" })),
    ...parsed.uncovered.map((u) => ({ target: u.target || u.product, verdict: "not covered" })),
  ];
  const result = { testable: true, procedures: results, inputs: parsed.inputs, targets, fork: forkInfo, createdServices: createdServiceInfo, teardown: teardownInfo, notes };
  saveRun(meta, result);
  const { overall, out } = buildReport(meta, result);

  // Archive this run whole: the report, the raw result, AND its screenshots. report.html and
  // last-run.json are single-file-per-run, so each run silently overwrote the evidence for the last —
  // and comparing a fix against the run that motivated it is most of what a page-at-a-time workflow
  // does.
  //
  // The screenshots have to come too. clearShots wipes them per prefix at the start of every run, so
  // archiving the report alone left it pointing at images a LATER run had replaced: a passing report
  // illustrated with pictures of a different attempt, which is worse than no archive. The report
  // references images by bare filename, so copying them beside it makes the directory self-contained.
  let archived = null;
  try {
    const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    const dir = join(SHOTS, "archive", `${prefix}-${stamp}`);
    mkdirSync(dir, { recursive: true });
    for (const f of ["report.html", "last-run.json"]) {
      const src = join(SHOTS, f);
      if (existsSync(src)) copyFileSync(src, join(dir, f));
    }
    let shots = 0;
    for (const f of readdirSync(SHOTS)) {
      if (f.startsWith(`${prefix}-`) && f.endsWith(".png")) {
        copyFileSync(join(SHOTS, f), join(dir, f));
        shots++;
      }
    }
    console.log(`  Archived: ${join("screenshots", "archive", `${prefix}-${stamp}`)}  (report + ${shots} screenshot(s))`);
    archived = dir; // the self-contained copy: what is worth opening, keeping, or sending on

    // Two runs of this page: the current one and the one before it. Two, because the only thing more
    // than one buys is COMPARING runs (168 screenshots against 71, a passing report against the run
    // that failed), and one would be pointless — the archive is written by copying the live folder, so
    // keeping one stores a second copy of what `screenshots/` already holds. Unpruned it reached
    // 176 MB across eight runs of a single page, and a sweep of the inventory would be gigabytes.
    // Scoped to this page's prefix, so a run never deletes another page's evidence.
    const KEEP = 2;
    const mine = readdirSync(join(SHOTS, "archive"))
      .filter((d) => d.startsWith(`${prefix}-`) && /-\d{4}-\d{2}-\d{2}T/.test(d))
      .sort()
      .reverse();
    for (const old of mine.slice(KEEP)) {
      rmSync(join(SHOTS, "archive", old), { recursive: true, force: true });
      console.log(`  pruned older run: ${old}`);
    }
  } catch (e) {
    console.log(`  (could not archive this run: ${(e.message || "").split("\n")[0]})`);
  }

  // The archived pair when there is one, because report.html there sits beside its own images and can
  // be moved or sent as a unit; the live report otherwise.
  reveal(archived ? join(archived, "report.html") : out, archived || SHOTS);
  if (slotBusy) console.error(`\n  Not run: ${slotBusy}\n`);
  if (stopRequested()) console.error(`\n  Interrupted (${stopReason()}): stopped early, after cleaning up.\n`);
  // 3 is also what a busy project lock exits with: the run did not happen, which is neither a pass nor a docs failure.
  // 130 is the shell's code for an interrupted command: the run was cut short, whatever it saw first.
  process.exit(stopRequested() ? 130 : slotBusy ? 3 : overall === "fail" ? 1 : 0);
}

main().catch((e) => { console.error("Error:", e); process.exit(1); });