#!/usr/bin/env node
// Dump a page's plan as a psql script: every `run SQL:` and compiled `expect` in plan order, wrapped
// in a transaction that ROLLS BACK. Nothing here needs a browser, a fork or a credential the tool
// holds; run the output through psql against the standing service and the plan's SQL is verified
// before a single cloud minute is spent on a walk:
//
//   node scripts/plan-sql.mjs <page-url> | tiger db connect $DOCTEST_SERVICE_AWS -- -q -f -
//
// Run it against the standing service rather than a local database: the extensions a page installs
// (postgis, pg_textsearch, vectorscale) are the Cloud builds, and a local PostgreSQL has none of
// them. The transaction means nothing sticks, extension installs included.
//
// `--drop <regex>` leaves out every statement matching the pattern. That is the negative case: drop
// the INSERT and the assertion that counts rows must fail, or it was never checking anything.
//
//   node scripts/plan-sql.mjs <page-url> --drop '^INSERT INTO covid_location' | tiger db connect … -- -q -f -
//
// Output is written for a person reading psql's echo: each statement is preceded by its step number,
// and assertions are marked, so a failure names the plan step to look at.
import { resolvePage } from "../lib/resolve-page.mjs";
import { parsePlan } from "../lib/plan.mjs";

const args = process.argv.slice(2);
const url = args.find((a) => !a.startsWith("--"));
if (!url) {
  console.error("usage: node scripts/plan-sql.mjs <page-url> [--drop <regex>]");
  process.exit(2);
}
const dropAt = args.indexOf("--drop");
const drop = dropAt >= 0 ? new RegExp(args[dropAt + 1], "i") : null;

const plan = parsePlan(resolvePage(url).mdx);
if (!plan.present) {
  console.error(`${url}: no <TestPlan> block`);
  process.exit(2);
}
// Step numbers are per block, as written on the page; a page with a block per product prints the
// SQL of every block, each step numbered the way its own block numbers it.
const sqls = plan.steps.flatMap((s) =>
  (s.actions || []).filter((a) => a.action === "run_sql").map((a) => ({ step: plan.plans.length > 1 ? `${s.block}.${s.n}` : s.n, sql: a.sql, assertion: !!a.assertion })),
);
if (!sqls.length) {
  console.error(`${url}: the plan runs no SQL`);
  process.exit(2);
}
const kept = sqls.filter((s) => !(drop && drop.test(s.sql)));
console.error(`${sqls.length} SQL step(s), ${kept.length} kept, ${sqls.filter((s) => s.assertion).length} assertion(s)`);

console.log("\\set ON_ERROR_STOP 1");
console.log("BEGIN;");
for (const s of kept) {
  console.log(`\\echo -- step ${s.step}${s.assertion ? " (assert)" : ""}`);
  // A page may print a statement without its semicolon (manually-drop-chunks does), and the walkers
  // run each statement on its own so it never matters there. In a psql script it does: the next
  // \echo is a meta-command, so the unterminated statement swallows the assertion after it.
  const sql = s.sql.trimEnd();
  console.log(/;$/.test(sql) ? sql : `${sql};`);
}
console.log("ROLLBACK;");
