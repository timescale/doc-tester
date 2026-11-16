// Run test-page over MANY pages: a list you provide, a section, or every page that has a plan.
//
//   node scripts/test-batch.mjs --pages pages.csv      one slug or URL per line (# comments ok,
//                                                      CSV: the first column is used)
//   node scripts/test-batch.mjs --section integrate    inventory slugs starting with this prefix
//   node scripts/test-batch.mjs --all                  every page that has a plan
//   node scripts/test-batch.mjs --section learn --resume   pick up the last batch where it stopped
//   node scripts/test-batch.mjs --section build --products self-hosted
//                                                      only the self-hosted side of each plan; a page
//                                                      whose plan does not cover it is skipped with a
//                                                      reason, not failed
//   node scripts/test-batch.mjs --section get-started --os ubuntu,debian
//                                                      only these distros of each bare plan; a page
//                                                      with no such block is skipped with a reason
//
// One CHILD PROCESS per page, deliberately. A page gets a fresh browser, so a stuck dialog, a crashed
// Playwright or an exhausted heap on one page cannot poison the next — and the entry point keeps its
// three process.exit paths instead of being restructured into a library. The saved Console session
// makes per-page login cheap.
//
// Sequential, also deliberately. Parallel runs would collide on the pre-run project reset (it is
// project-wide), on the standing service, and on the one Console session.
//
// Wall clock is the constraint: at roughly 25 minutes a page, --all over every page with a plan is days, so a
// batch is an overnight or CI job and --section is the realistic daily unit. Hence resumability: a
// crash or a Ctrl-C must not mean re-running the pages that already passed.
import { spawn } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { resolvePage } from "../lib/resolve-page.mjs";
import { parsePlan, runUnits, TARGETS, OSES } from "../lib/plan.mjs";
import { overallVerdict, savedRunSince } from "../lib/report.mjs";
import { SHOTS } from "../lib/walk.mjs";
import { isSettled, splitResume, flagsMismatch, uniqueBatchName, batchExitCode } from "../lib/batch-resume.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DOCS = process.env.DOCS_REPO || join(process.env.HOME, "Timescale", "Tiger-Data-Docs");
const PAGE_TIMEOUT_MS = Number(process.env.DOCTEST_PAGE_TIMEOUT_MS || 45 * 60 * 1000);
const BASE = "https://www.tigerdata.com/docs/";

const argv = process.argv.slice(2);
const flag = (name) => {
  const i = argv.indexOf(name);
  return i === -1 ? null : argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : true;
};

const asUrl = (entry) => (entry.startsWith("http") ? entry : BASE + entry.replace(/^\/+|\/+$/g, ""));

// Passed through to every child. Validated here once rather than 200 times by the children, and so
// a typo fails the batch before it provisions anything.
const products = typeof flag("--products") === "string" ? flag("--products").split(",").map((x) => x.trim().toLowerCase()).filter(Boolean) : null;
for (const w of products || []) {
  if (!TARGETS.some((t) => t.name === w)) {
    console.error(`\n  --products ${w}: not a product this tool can run on. Known: ${TARGETS.map((t) => t.name).join(", ")}\n`);
    process.exit(2);
  }
}

// Same again for the distros (docs/adr/0008): without it a page with six bare blocks runs six boxes.
const osList = typeof flag("--os") === "string" ? flag("--os").split(",").map((x) => x.trim().toLowerCase()).filter(Boolean) : null;
for (const w of osList || []) {
  if (!OSES.includes(w)) {
    console.error(`\n  --os ${w}: not a distro this tool can provision. Known: ${OSES.join(", ")}\n`);
    process.exit(2);
  }
}

function readList(file) {
  return readFileSync(file, "utf8")
    .split("\n")
    .map((l) => l.split(",")[0].replace(/#.*$/, "").trim()) // CSV: first column; # comments
    .filter(Boolean)
    .filter((l) => !/^(url|page|slug)$/i.test(l)); // a header row is not a page
}

// Every page that carries a plan, found by walking the docs tree.
//
// This replaced a hand-maintained inventory file in the docs repo, which was the wrong shape twice
// over. It could not stay current: a page added, renamed or moved in the docs had to be mirrored by
// hand in a list nobody adding a page had a reason to open, and the list's own header admitted it was
// unreviewed. And it was never load-bearing: `--all` read the inventory and then kept only the
// entries whose page has a <TestPlan>, so the run set was always "pages with a plan" and the file
// only narrowed the search. Reading the tree gives the same set and cannot drift.
//
// Note what this does NOT give back: a worklist of pages worth writing a plan for. That is a human
// judgement, it was the unreviewed part, and it does not belong in a file a tool reads.
function pagesWithPlans() {
  const root = join(DOCS, "src", "content", "docs");
  if (!existsSync(root)) {
    console.error(`\n  no docs content at ${root} — set DOCS_REPO to your Tiger-Data-Docs checkout\n`);
    process.exit(2);
  }
  // A plan can live in a PARTIAL rather than on the page: the AWS and Azure security pages share one
  // plan in _security-members.mdx, and a page-only string test silently reports 1 page instead of 3.
  // So collect the partials that carry a plan first, then a page qualifies by holding a plan itself
  // or by importing one of them.
  const partials = join(DOCS, "src", "partials");
  const plannedPartials = existsSync(partials)
    ? readdirSync(partials).filter((n) => n.endsWith(".mdx") && readFileSync(join(partials, n), "utf8").includes("<TestPlan"))
    : [];

  const out = [];
  const walk = (dir, prefix) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p, `${prefix}${e.name}/`);
      else if (e.name.endsWith(".mdx") && !e.name.startsWith("_")) {
        const mdx = readFileSync(p, "utf8");
        // String tests rather than parsing all 600-odd pages to find a handful.
        if (mdx.includes("<TestPlan") || plannedPartials.some((n) => mdx.includes(n)))
          out.push(`${prefix}${e.name.replace(/\.mdx$/, "")}`);
      }
    }
  };
  walk(root, "");
  return out.sort();
}

// --- what to run
let entries = null;
const pagesFile = flag("--pages");
const section = flag("--section");
if (typeof pagesFile === "string") entries = readList(pagesFile);
else if (typeof section === "string") entries = pagesWithPlans().filter((s) => s.startsWith(section.replace(/^\/+/, "")));
else if (argv.includes("--all")) entries = pagesWithPlans();

if (!entries?.length) {
  console.error(`
  Usage:
    node scripts/test-batch.mjs --pages <file>      one slug or URL per line
    node scripts/test-batch.mjs --section <prefix>  e.g. integrate, deploy/tiger-cloud
    node scripts/test-batch.mjs --all               every page that has a plan
    ... --resume                                    continue the most recent batch
    ... --dry-run                                   list what would run, and for how long
    ... --products cloud,self-hosted                only these products of each plan
    ... --os ubuntu,debian                          only these distros of each bare plan
`);
  process.exit(2);
}

// --- split into what can run and what has no plan yet
// A page with no <TestPlan> is COVERAGE information, not a failure, and spawning a child to be told
// so wastes a process and overwrites the live report with a "not testable" one. So is a page whose
// plan covers none of the products asked for, and a plan with grammar errors is listed here with
// them rather than spawned to exit 2 (it is the author's input, not the page, that is wrong).
const runnable = [];
const noPlan = [];
for (const entry of entries) {
  const url = asUrl(entry);
  try {
    const page = resolvePage(url);
    const plan = parsePlan(page.mdx, { products: page.frontmatter?.products });
    const title = page.frontmatter?.title || entry;
    if (!plan.present) noPlan.push({ entry, url, title });
    else if (plan.errors.length) noPlan.push({ entry, url, title, error: `plan error: ${plan.errors[0].detail}${plan.errors.length > 1 ? ` (+${plan.errors.length - 1} more)` : ""}` });
    else if (products && !plan.targets.some((t) => products.includes(t))) noPlan.push({ entry, url, title, error: `plan targets ${plan.targets.join(", ")}, not ${products.join(", ")}` });
    else {
      // A run unit is a (target, block) pair, each on its own box (docs/adr/0008), so this is what the
      // child will actually walk, and what --dry-run has to count.
      const { units } = runUnits(plan, products, osList);
      if (!units.length) noPlan.push({ entry, url, title, error: `no block for ${osList.join(", ")} (--os)` });
      else runnable.push({ entry, url, title, targets: plan.targets, units: units.length, products: page.frontmatter?.products || [] });
    }
  } catch (e) {
    noPlan.push({ entry, url, title: entry, error: (e.message || "").split("\n")[0] });
  }
}

// --dry-run: what WOULD run. A batch is measured in hours, so seeing its scope first is not a luxury.
if (argv.includes("--dry-run")) {
  console.log(`\n  ${runnable.length} page(s) would run${products ? ` (products: ${products.join(", ")})` : ""}:`);
  for (const p of runnable) console.log(`    ${p.url.replace(BASE, "")}  (${p.targets.join(", ")}${p.units > 1 ? `; ${p.units} runs` : ""})`);
  if (noPlan.length) {
    console.log(`\n  ${noPlan.length} with no plan yet (skipped, not failures):`);
    for (const p of noPlan) console.log(`    ${p.url.replace(BASE, "")}${p.error ? `  (${p.error})` : ""}`);
  }
  const mins = runnable.reduce((n, p) => n + p.units, 0) * 25;
  console.log(`\n  rough wall clock at ~25 min a run: ${mins} min (${(mins / 60).toFixed(1)} h)\n`);
  process.exit(0);
}

// --- batch directory, resumable
// DOCTEST_BATCH_ROOT, DOCTEST_PAGE_SCRIPT and DOCTEST_BATCH_NOW exist so scripts/check-batch-resume.mjs can run this
// script against a stub child in a throwaway directory, without touching the real batch history.
const batchRoot = process.env.DOCTEST_BATCH_ROOT || join(SHOTS, "batches");
const PAGE_SCRIPT = process.env.DOCTEST_PAGE_SCRIPT || join(ROOT, "scripts", "test-page.mjs");
const now = process.env.DOCTEST_BATCH_NOW ? new Date(process.env.DOCTEST_BATCH_NOW) : new Date();
mkdirSync(batchRoot, { recursive: true });
let dir = null;
if (argv.includes("--resume")) {
  const prior = readdirSync(batchRoot).filter((d) => d.startsWith("batch-")).sort().reverse();
  if (prior.length) dir = join(batchRoot, prior[0]);
}
if (!dir) dir = join(batchRoot, uniqueBatchName(readdirSync(batchRoot), `batch-${now.toISOString().replace(/[:.]/g, "-").slice(0, 19)}`));
mkdirSync(dir, { recursive: true });
const statePath = join(dir, "state.json");
const flags = { products, os: osList };
const state = existsSync(statePath) ? JSON.parse(readFileSync(statePath, "utf8")) : { done: {} };
// A resume reuses the latest batch, so one started with other flags would skip pages these flags mean to run.
const mismatch = argv.includes("--resume") ? flagsMismatch(state.flags, flags) : null;
if (mismatch) {
  console.error(`\n  --resume: ${mismatch}\n`);
  process.exit(2);
}
state.flags ??= flags; // a new batch records its flags; one from before they were recorded gets them now
const save = () => writeFileSync(statePath, JSON.stringify(state, null, 2));

console.log(`\n  ${runnable.length} page(s) to run, ${noPlan.length} with no plan yet`);
console.log(`  batch: ${dir}${argv.includes("--resume") ? "  (resumed)" : ""}`);
// Only a page with a verdict is done: one that timed out or crashed has none, and runs again.
const { skip, again } = splitResume(runnable, state.done);
if (skip.length) {
  const tally = Object.entries(skip.reduce((t, p) => ({ ...t, [state.done[p.url].verdict]: (t[state.done[p.url].verdict] || 0) + 1 }), {})).map(([v, n]) => `${v} ${n}`).join(", ");
  console.log(`  ${skip.length} already done in this batch (${tally}), skipping`);
}
if (again.length) {
  console.log(`  ${again.length} will run again (no verdict last time):`);
  for (const { page, verdict } of again) console.log(`    ${verdict || "no verdict"}  ${page.url.replace(BASE, "")}`);
}

// --- run one page in its own process; never let a failure stop the batch
function runPage(p) {
  return new Promise((resolve) => {
    const log = join(dir, `${p.url.split("/").filter(Boolean).pop()}.log`);
    const out = [];
    const started = Date.now();
    const child = spawn(process.execPath, [PAGE_SCRIPT, p.url, ...(products ? ["--products", products.join(",")] : []), ...(osList ? ["--os", osList.join(",")] : [])], {
      cwd: ROOT,
      env: { ...process.env, NO_OPEN: "1" }, // a batch must not open 200 browser windows
    });
    const timer = setTimeout(() => child.kill("SIGKILL"), PAGE_TIMEOUT_MS);
    const collect = (b) => {
      const s = b.toString();
      out.push(s);
      process.stdout.write(s.replace(/^/gm, "    "));
    };
    child.stdout.on("data", collect);
    child.stderr.on("data", collect);
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      writeFileSync(log, out.join(""));
      // Grade from the run's own saved result, using the report's rule rather than a copy of it.
      // Exit 2 is test-page refusing its input before it ran anything (a plan error, drift from the
      // guide, a bad flag): not a crash, and not a result either.
      let verdict = signal ? "timeout" : code === 0 ? "unknown" : code === 2 ? "refused" : "crashed";
      let archive = null;
      let targets = null; // per-product verdicts, as the run saved them
      // Only a result this child wrote: one that is older is the previous run's, and a child that never
      // got as far as saving one must keep its process-level verdict.
      const saved = savedRunSince(started);
      if (saved?.meta?.url === p.url) { verdict = overallVerdict(saved.result); targets = saved.result?.targets || null; }
      const m = out.join("").match(/Archived: (\S+)/);
      if (m) archive = m[1];
      resolve({ ...p, verdict, targets, archive, log, code, signal });
    });
  });
}

const results = [];
for (const p of runnable) {
  if (isSettled(state.done[p.url]?.verdict)) { results.push(state.done[p.url]); continue; }
  console.log(`\n${"=".repeat(70)}\n  ${p.title}\n  ${p.url}\n${"=".repeat(70)}`);
  const r = await runPage(p);
  state.done[p.url] = r;
  save();
  results.push(r);
}

// --- summary
const GLYPH = { pass: "✓", fail: "✗", blocked: "⚠", stopped: "🛑", skipped: "—", timeout: "⏱", crashed: "💥", refused: "🚫", unknown: "?" };
// One column per product the tool knows (docs/adr/0006). A cell is the product's own verdict, "not
// run" when --products left it out, "not covered" when the page is tagged with it and no block
// targets it, and blank when the page is not tagged with it at all. Informational: nothing here
// changes the page verdict or the exit code.
const cell = (r, name) => {
  // Several rows share a product once a bare plan is written per distro (docs/adr/0008): show each,
  // so a failing distro is never hidden behind a passing one.
  const mine = r.targets?.filter((x) => x.target === name) || [];
  if (mine.length) return mine.map((t) => (t.verdict === "skipped" ? "— nothing to test" : GLYPH[t.verdict] ? `${GLYPH[t.verdict]} ${t.verdict}` : t.verdict) + (t.os ? ` (${[t.os, t.path].filter(Boolean).join(", ")})` : "")).join(" / ");
  const product = TARGETS.find((x) => x.name === name)?.product;
  return r.products?.includes(product) ? (r.targets ? "not covered" : "?") : "";
};
const rows = results.map((r) => `| ${GLYPH[r.verdict] || "?"} ${r.verdict} | ${TARGETS.map((t) => cell(r, t.name)).join(" | ")} | ${r.title} | ${r.url.replace(BASE, "")} | ${r.archive || ""} |`);
const md = [
  `# Batch run — ${new Date().toISOString()}`,
  "",
  `${results.length} page(s) run, ${noPlan.length} with no plan yet${products ? `, products: ${products.join(", ")}` : ""}${osList ? `, os: ${osList.join(", ")}` : ""}.`,
  "",
  `| verdict | ${TARGETS.map((t) => t.name).join(" | ")} | page | slug | evidence |`,
  `|---|${TARGETS.map(() => "---|").join("")}---|---|---|`,
  ...rows,
  "",
  ...(noPlan.length ? ["## No plan yet", "", ...noPlan.map((p) => `- ${p.url.replace(BASE, "")}${p.error ? ` (${p.error})` : ""}`)] : []),
  "",
].join("\n");
writeFileSync(join(dir, "summary.md"), md);

console.log(`\n${"=".repeat(70)}`);
for (const r of results) console.log(`  ${GLYPH[r.verdict] || "?"} ${r.verdict.padEnd(8)} ${r.url.replace(BASE, "")}  ${TARGETS.map((t) => `${t.name}: ${cell(r, t.name) || "n/a"}`).join(", ")}`);
if (noPlan.length) {
  console.log(`\n  no plan yet (${noPlan.length}):`);
  for (const p of noPlan) console.log(`    ${p.url.replace(BASE, "")}${p.error ? `  (${p.error})` : ""}`);
}
console.log(`\n  summary: ${join(dir, "summary.md")}\n`);
process.exit(batchExitCode(results));
