// Rebuild screenshots/report.html from the last run's saved results (screenshots/last-run.json),
// without re-walking the Console. Use after tweaking the report's styling/layout.
//
// Usage: node scripts/build-report.mjs

import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { SHOTS } from "../lib/walk.mjs";
import { buildReport } from "../lib/report.mjs";

const file = join(SHOTS, "last-run.json");
if (!existsSync(file)) {
  console.error(`No saved run at ${file}. Run scripts/test-page.mjs first.`);
  process.exit(1);
}
const { meta, result } = JSON.parse(readFileSync(file, "utf8"));
buildReport(meta, result);