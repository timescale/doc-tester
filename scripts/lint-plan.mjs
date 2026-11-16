#!/usr/bin/env node
// Lint a page's <TestPlan> without touching the Console.
//
// Everything here is a pure function of the page text: no browser, no service, no credentials, no
// fork. That is the point. Until now the grammar gate (parsePlan) was the only thing an author could
// run before a walk, and the control check lived inside test-page.mjs — so a plan pressing a control
// the page never names was found only AFTER provisioning a service and driving the Console. For a
// check that needs nothing but the file, that is the wrong end of the loop.
//
// Usage:
//   node scripts/lint-plan.mjs <page-url> [more page-urls...]
//   node scripts/lint-plan.mjs --all
//
// Exit code is 1 if anything was reported, so this can gate a commit or a CI job later. Reports are
// written for the person writing the plan: what is wrong, on which step, and what to do about it.

import { readdirSync, statSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { resolvePage, DOCS_REPO } from "../lib/resolve-page.mjs";
import { parsePlan } from "../lib/plan.mjs";
import { controlsNotNamedOnPage, statementsDriftedFromPage, proceduresNotCovered, statementsNotRun, statementsOutOfPageOrder, guideCommandDrift, untaggedFences, isDevFixtureRepo } from "../lib/fidelity.mjs";
import { describeGuideDrift, describeUntagged } from "../lib/guide-report.mjs";

const CONTENT = join(DOCS_REPO, "src", "content", "docs");

// Every page that HAS a plan. A page without one is not a failure: it has not been written yet, and
// keeping those two apart is what makes plan coverage countable.
function allPlannedPages() {
  const out = [];
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      if (statSync(full).isDirectory()) walk(full);
      else if (name.endsWith(".mdx")) {
        const url = relative(CONTENT, full).replace(/\.mdx$/, "");
        try {
          if (parsePlan(resolvePage(url).mdx).present) out.push(url);
        } catch {}
      }
    }
  };
  walk(CONTENT);
  return out;
}

function lintOne(url) {
  const { mdx, frontmatter, file } = resolvePage(url);
  const plan = parsePlan(mdx, { products: frontmatter?.products });
  if (!plan.present) return { url, missing: true, findings: [] };

  const findings = [];

  // The page's own file, before partials are inlined. A <TestPlan> block written on a page without
  // `import TestPlan from "@components/TestPlan.astro"` parses fine here and fails the docs BUILD
  // ("Expected component `TestPlan` to be defined"), which is the wrong end of the loop to learn it
  // at: a Vercel deploy, after the PR is open. A partial's block is the partial's business, and all
  // of them import it.
  const raw = readFileSync(file, "utf8");
  if (/<TestPlan\b/.test(raw) && !/^\s*import\s+TestPlan\s+from\s+["']@components\/TestPlan\.astro["']/m.test(raw)) {
    findings.push({ kind: "component not imported", detail: "the page has a <TestPlan> block and no `import TestPlan from \"@components/TestPlan.astro\";`", fix: "add the import with the page's other imports, or the docs build fails" });
  }
  // Step numbers are per block, as written. On a page with a block per product, "step 3" alone
  // would be ambiguous, so the block number is kept in front of it.
  const stepOf = (block, n) => (plan.plans.length > 1 ? `${block}.${n}` : n);

  // 0. Rules the grammar enforces beyond the verb set: an unknown product in `target:`, a prefix the
  //    block does not cover, an unprefixed one-sided verb in a two-target block, two blocks claiming
  //    one product, the retired fork line. A plan with any of these does not run, so they come first.
  for (const e of plan.errors) {
    findings.push({ kind: "plan error", step: e.step ? stepOf(e.block, e.step) : undefined, detail: e.detail, fix: "see docs/adr/0006 for the target and prefix rules" });
  }

  // 1. Grammar. A line matching no verb is REPORTED, never skipped — it would otherwise be silently
  //    dropped from the walk and the plan would look shorter than it is.
  for (const line of plan.unparsed) {
    findings.push({ kind: "unparsed", detail: `no verb matches: ${line}`, fix: "check the verb set in src/components/TestPlan.astro" });
  }

  // 2 and 3 are per block, because their step numbers are: a control the plan presses that the page
  // never names (either the page is missing a step or the plan invented a path; both need a person),
  // and a statement that is almost, but not exactly, one the page prints.
  for (const block of plan.plans) {
    // A bare plan is held to every command in its reader's path (docs/adr/0010). A dev fixture has no
    // guide to be held to, so there it says so instead of passing quietly.
    if (block.machine === "bare" && block.os) {
      if (isDevFixtureRepo(DOCS_REPO)) {
        findings.push({ kind: "guide fidelity not checked", advisory: true, step: undefined, detail: `block ${block.index} (${[block.os, block.path].filter(Boolean).join(", ")}): the page is a dev fixture, not the guide`, fix: "only a plan on the real page is evidence about the guide (docs/adr/0010)" });
      } else {
        for (const d of guideCommandDrift(mdx, block)) findings.push({ ...describeGuideDrift(d, block, stepOf), });
        for (const u of untaggedFences(mdx, block)) findings.push(describeUntagged(u, block));
      }
    }
    for (const d of controlsNotNamedOnPage(mdx, block, DOCS_REPO)) {
      findings.push({
        kind: "control not on page",
        step: stepOf(block.index, d.step),
        detail: `\`${d.label}\``,
        fix: "name it on the page in code font, or press the control the page actually names",
      });
    }
    // A bare block's statements are held to the strict check above, which replaces these two: they read
    // the whole page fuzzily, where a bare plan has a reader's path and an exact contract.
    const bare = block.machine === "bare";
    for (const d of bare ? [] : statementsDriftedFromPage(mdx, block)) {
      findings.push({
        kind: "statement drifted",
        step: stepOf(block.index, d.step),
        detail: `plan: ${d.statement}\n        page: ${d.closest}   (${Math.round(d.score * 100)}% alike)`,
        fix: "copy the page's statement, or fix the page if the plan is the correct one",
      });
    }
    for (const d of bare ? [] : statementsOutOfPageOrder(mdx, block, DOCS_REPO)) {
      findings.push({ kind: "out of page order", step: stepOf(block.index, d.step), detail: d.statement, fix: "keep the page's order, so a reader and the run see the same sequence" });
    }
  }

  // 4. Coverage, from the page's side: a documented procedure the plan neither drives nor declares
  //    under `Not scripted:`, a SQL block it never runs, and a statement run out of page order.
  for (const d of proceduresNotCovered(mdx, plan, DOCS_REPO)) {
    findings.push({ kind: "procedure not covered", detail: d.heading, fix: "drive it, or name it under `Not scripted:` with the reason" });
  }
  // Skipped on a page with a bare block: it reads every tab's statements against the plan as a whole,
  // and cannot see an `answer` typed at a psql prompt. The strict check owns a bare plan's coverage.
  for (const d of plan.plans.some((b) => b.machine === "bare") ? [] : statementsNotRun(mdx, plan, DOCS_REPO)) {
    findings.push({ kind: d.inline ? "inline statement not run" : "statement not run", detail: `${d.heading}: ${d.statement}`, fix: "run it, or declare its section under `Not scripted:`" });
  }

  // Coverage from the page's other side: a product the page is tagged with that no block targets.
  // Informational, never counted — it is the state of every plan on a both-tagged page written
  // before `target:` existed, and what the batch summary lists as "not covered".
  for (const u of plan.uncovered) {
    findings.push({
      kind: "product not covered",
      advisory: true,
      detail: u.target ? `the page is tagged ${u.product}; no <TestPlan> block targets ${u.target}` : `the page is tagged ${u.product}, which this tool has no substrate for`,
      fix: u.target ? `add ${u.target} to \`target:\` if the steps are shared, or write a second <TestPlan> block with \`target: ${u.target}\`` : "nothing to do until a substrate exists",
    });
  }

  // 5. Advisory, not a failure: a plan whose every step is a click carries the weakest evidence
  //    there is. It says a control was found and pressed, not that anything happened.
  const acts = plan.steps.flatMap((s) => s.actions || []);
  // A self-hosted plan asserts on a second database with a shell test whose exit code fails the
  // step: `test "$(psql -d restored -tAc "SELECT count(*) …")" = 721`. That is an assertion too.
  const SHELL_TEST = /^(?:test\s|\[\s)/;
  const asserts = acts.filter((a) => a.assertion || a.action === "expect_url" || a.action === "expect_label" || a.action === "expect_output" || a.action === "expect_enabled" || (a.action === "run_shell" && SHELL_TEST.test(a.command || "")));
  if (acts.length && !asserts.length) {
    findings.push({ kind: "no assertions", detail: "every step is a press; nothing checks an outcome", fix: "end on an expect step, so the plan proves something happened" });
  }

  return { url, findings, steps: plan.steps.length, asserts: asserts.length, targets: plan.targets.join(", ") };
}

const args = process.argv.slice(2);
const urls = args.includes("--all") ? allPlannedPages() : args;
if (!urls.length) {
  console.error("usage: node scripts/lint-plan.mjs <page-url>... | --all");
  process.exit(2);
}

let total = 0;
for (const url of urls) {
  let r;
  try {
    r = lintOne(url);
  } catch (e) {
    console.log(`\n${url}\n  ! could not read: ${(e.message || "").split("\n")[0]}`);
    total++;
    continue;
  }
  if (r.missing) {
    console.log(`\n${url}\n  no <TestPlan> on this page — nothing to lint`);
    continue;
  }
  if (!r.findings.length) {
    console.log(`\n${url}\n  clean — ${r.steps} steps, ${r.asserts} assertion(s), targets ${r.targets}`);
    continue;
  }
  console.log(`\n${url}  (${r.steps} steps, ${r.asserts} assertion(s), targets ${r.targets})`);
  for (const f of r.findings) {
    if (!f.advisory) total++;
    console.log(`  ${f.step ? `step ${f.step}: ` : ""}${f.kind}${f.advisory ? " (advisory)" : ""}`);
    console.log(`        ${f.detail}`);
    console.log(`     -> ${f.fix}`);
  }
}
console.log(total ? `\n${total} finding(s).` : "\nNo findings.");
process.exit(total ? 1 : 0);
