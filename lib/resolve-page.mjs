// Turn a docs URL into the MDX content the walker reads.
//
// A docs page often just renders an imported partial (e.g. read-scaling.mdx is `<HAReadScaling />`),
// so the real steps live in src/partials/. This resolver:
//   1. maps the URL to the page file on disk (case-insensitive — URLs are lowercased, folders aren't),
//   2. follows the page's partial imports and inlines them, so the extractor sees the real steps,
//   3. reads the frontmatter (title, products) so we can report what the page is and gate scope.
//
// Point it at a different docs checkout with the DOCS_REPO env var.

import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const _ENV = join(dirname(fileURLToPath(import.meta.url)), "..", ".env");
if (existsSync(_ENV)) process.loadEnvFile(_ENV);

export const DOCS_REPO = process.env.DOCS_REPO || join(process.env.HOME, "Timescale", "Tiger-Data-Docs");
const CONTENT = join(DOCS_REPO, "src", "content", "docs");

// "https://www.tigerdata.com/docs/deploy/.../read-scaling" -> ["deploy", ..., "read-scaling"]
function urlToSegments(input) {
  let s = String(input).trim();
  s = s.replace(/^https?:\/\/[^/]+/i, ""); // drop scheme + host
  s = s.replace(/[?#].*$/, ""); // drop query / hash
  s = s.replace(/^\/+|\/+$/g, ""); // trim slashes
  s = s.replace(/^docs\//i, ""); // drop the /docs prefix
  return s.split("/").filter(Boolean);
}

// Walk the content tree segment by segment, matching folder/file names case-insensitively.
function findFile(segments) {
  if (!segments.length) return null;
  let dir = CONTENT;
  for (let i = 0; i < segments.length - 1; i++) {
    const sub = readdirSync(dir, { withFileTypes: true })
      .find((e) => e.isDirectory() && e.name.toLowerCase() === segments[i].toLowerCase());
    if (!sub) return null;
    dir = join(dir, sub.name);
  }
  const leaf = segments[segments.length - 1].toLowerCase();
  const entries = readdirSync(dir, { withFileTypes: true });
  // <leaf>.mdx
  const file = entries.find((e) => e.isFile() && e.name.toLowerCase() === `${leaf}.mdx`);
  if (file) return join(dir, file.name);
  // <leaf>/index.mdx
  const folder = entries.find((e) => e.isDirectory() && e.name.toLowerCase() === leaf);
  if (folder) {
    const idx = readdirSync(join(dir, folder.name)).find((n) => n.toLowerCase() === "index.mdx");
    if (idx) return join(dir, folder.name, idx);
  }
  return null;
}

// Replace `<Name />` (and `<Name>...</Name>`) with the content of the .mdx imported as Name.
// Recurses so a partial that pulls in further partials is fully expanded. Partials carry no
// frontmatter, but strip any defensively so it never leaks into the extracted text.
function inlinePartials(mdx, fileDir, depth = 0) {
  if (depth > 6) return mdx;
  const imports = {};
  for (const m of mdx.matchAll(/import\s+(\w+)\s+from\s+["']([^"']+\.mdx)["']\s*;?/g)) {
    // Pages import partials two ways: a relative path, or the `@partials/` alias from tsconfig. The
    // alias resolved against the page's directory to a path that does not exist and was skipped
    // WITHOUT A WORD, so every partial a page pulled in that way (107 pages on 2026-09-18) was
    // invisible to the tool: no steps, no plan, "nothing to lint" on a page that had one.
    imports[m[1]] = m[2].startsWith("@partials/")
      ? join(DOCS_REPO, "src", "partials", m[2].slice("@partials/".length))
      : resolve(fileDir, m[2]);
  }
  let out = mdx;
  for (const [name, p] of Object.entries(imports)) {
    if (!existsSync(p)) continue;
    const usage = new RegExp(`<${name}(?:\\s[^>]*)?/>|<${name}(?:\\s[^>]*)?>[\\s\\S]*?</${name}>`, "g");
    if (!usage.test(out)) continue;
    let partial = readFileSync(p, "utf8").replace(/^---\n[\s\S]*?\n---\n?/, "");
    partial = inlinePartials(partial, dirname(p), depth + 1);
    out = out.replace(usage, () => partial);
  }
  return out;
}

// Resolve the {C.X} / ${C.X} product-name constants to their real text, so extracted step titles
// read "In Tiger Cloud Console, select your target service" instead of "In , select your target".
// Parses src/constants.ts (values can reference each other, e.g. CONSOLE = `${PRODUCT_PREFIX} Console`).
let CONSTANTS = null;
function loadConstants() {
  if (CONSTANTS) return CONSTANTS;
  CONSTANTS = {};
  const file = join(DOCS_REPO, "src", "constants.ts");
  if (!existsSync(file)) return CONSTANTS;
  const raw = {};
  for (const m of readFileSync(file, "utf8").matchAll(/export const (\w+)\s*=\s*([^;]+);/g)) raw[m[1]] = m[2].trim();
  const resolveVal = (expr, depth = 0) => {
    if (depth > 8) return null;
    expr = expr.trim();
    const lit = expr.match(/^['"`]([\s\S]*)['"`]$/);
    if (lit) return lit[1].replace(/\$\{(\w+)\}/g, (_m, n) => (raw[n] != null ? resolveVal(raw[n], depth + 1) ?? "" : ""));
    if (/^\w+$/.test(expr) && raw[expr] != null) return resolveVal(raw[expr], depth + 1);
    return null; // concatenations / expressions we don't evaluate
  };
  for (const k of Object.keys(raw)) {
    const v = resolveVal(raw[k]);
    if (v != null) CONSTANTS[k] = v;
  }
  return CONSTANTS;
}

function resolveConstants(mdx) {
  const c = loadConstants();
  return mdx
    // A constant that IS an attribute's entire value has to come back QUOTED. Substituting it bare
    // turns `<TabItem label={C.CONSOLE}>` into `<TabItem label=Tiger Console>`, and every attribute
    // regex downstream (splitTabs' tabItemRe, extractSteps' itemRe) accepts only "a quoted string"
    // or a {`template`} — so the element it labelled matched nothing and vanished without a word.
    // 19 <TabItem label={C.X}> across 11 files, usually the Console half of a Console/CLI pair,
    // which is the half this tool can actually walk. No constant's value contains a double quote,
    // so quoting needs no escaping. Must run BEFORE the bare {C.X} rule below, which would eat it.
    .replace(/=\{C\.(\w+)\}/g, (m, n) => (c[n] != null ? `="${c[n]}"` : m))
    .replace(/\$\{C\.(\w+)\}/g, (m, n) => (c[n] != null ? c[n] : ""))
    .replace(/\{C\.(\w+)\}/g, (m, n) => (c[n] != null ? c[n] : m));
}

function parseFrontmatter(mdx) {
  const m = mdx.match(/^---\n([\s\S]*?)\n---/);
  if (!m) return {};
  const block = m[1];
  const fm = {};
  const title = block.match(/^title:\s*(.+)$/m);
  if (title) fm.title = title[1].trim().replace(/^["']|["']$/g, "");
  const products = block.match(/^products:\s*\[([^\]]*)\]/m);
  if (products) fm.products = products[1].split(",").map((s) => s.trim()).filter(Boolean);
  // Doc testing tool metadata (see Tiger-Data-Docs' testingSchema): test: manual means the whole
  // page needs a human or third-party tool the browser walk can't drive; requires names what.
  const test = block.match(/^test:\s*(.+)$/m);
  if (test) fm.test = test[1].trim().replace(/^["']|["']$/g, "");
  const requires = block.match(/^requires:\s*(.+)$/m);
  if (requires) fm.requires = requires[1].trim().replace(/^["']|["']$/g, "");
  // Integration pages (src/content.config.ts integrationSchema) tag which cloud(s) they apply to —
  // e.g. `integrationPlatforms: ["azure"]` on azure-monitor.mdx. This is the only per-cloud signal
  // on pages outside deploy/tiger-cloud/tiger-cloud-{AWS,azure}/ (`products` only distinguishes
  // cloud/self_hosted/mst, never AWS vs Azure specifically — confirmed against the schema).
  const platforms = block.match(/^integrationPlatforms:\s*\[([^\]]*)\]/m);
  if (platforms) fm.integrationPlatforms = platforms[1].split(",").map((s) => s.trim().replace(/^["']|["']$/g, "")).filter(Boolean);
  return fm;
}

// Which cloud (aws/azure) a page's Console procedures should run against. Two signals, in order:
//   1. Directory path under deploy/tiger-cloud/tiger-cloud-{AWS,azure}/ — the strong, structural
//      signal, but only covers that one subtree.
//   2. `integrationPlatforms` frontmatter, when it names exactly one cloud (e.g. azure-monitor.mdx,
//      Azure-only, lives under integrate/ — outside the tiger-cloud-AWS/azure directories entirely).
// Neither present (page is cloud-neutral, or supports both) -> default to aws.
function detectCloud(segments, frontmatter) {
  const lower = segments.map((s) => s.toLowerCase());
  if (lower.includes("tiger-cloud-aws")) return "aws";
  if (lower.includes("tiger-cloud-azure")) return "azure";
  const platforms = (frontmatter.integrationPlatforms || []).filter((p) => p === "aws" || p === "azure");
  if (platforms.length === 1) return platforms[0];
  return "aws";
}


// url -> { url, file, slug, frontmatter, mdx } where mdx has partials inlined.
// Throws a clear, user-facing message if the page can't be located.
export function resolvePage(url) {
  const segments = urlToSegments(url);
  const file = findFile(segments);
  if (!file) {
    throw new Error(
      `Could not find a docs page for "${url}".\n` +
        `  Looked under: ${CONTENT}\n` +
        `  As path: ${segments.join("/")}.mdx\n` +
        `  Check the URL, or set DOCS_REPO to your Tiger-Data-Docs checkout.`
    );
  }
  const raw = readFileSync(file, "utf8");
  const frontmatter = parseFrontmatter(raw);
  return {
    url,
    file,
    slug: "/" + segments.join("/"),
    frontmatter,
    cloud: detectCloud(segments, frontmatter),
    mdx: resolveConstants(inlinePartials(raw, dirname(file))),
  };
}
/**
 * The images a page publishes INSIDE a procedure, and the control labels around each.
 *
 * For DOCTEST_SHOTS=doc-update. A docs image has to be regenerated at the moment of the flow it
 * illustrates, and the plan deliberately does not say where that is — a plan is a script of actions,
 * not a picture list. But the page already knows: a <ThemeImage> inside a <NumberedItem> is an image
 * of that step, and the item's backticked labels name the controls that reach it. Matching those
 * labels to the plan steps that click them locates the moment without anyone naming a step by hand.
 *
 * Images OUTSIDE a NumberedItem are excluded: those are conceptual diagrams, not screenshots of the
 * product, and no run can regenerate them.
 *
 * Returns [{ asset, labels }] where asset is the imported path of the light variant.
 */
export function docImageMoments(mdx) {
  const imports = new Map();
  for (const m of mdx.matchAll(/^\s*import\s+(\w+)\s+from\s+["']([^"']+\.(?:png|jpe?g|webp|svg))["']\s*;?\s*$/gim)) {
    imports.set(m[1], m[2]);
  }

  // How often each backticked label appears in the page's prose. A label locates a moment only if it
  // is UNIQUE: `Explorer` opens half the procedures on a page, so as a locator it would force the
  // tiering image to be re-shot at every step that happens to start there (observed: step 55, an
  // aggregate step, forced the tiering screenshot). Same for `Continue` and `Close`. Counting is the
  // general fix; special-casing nav paths would only fix one instance.
  // The <TestPlan> block is not prose and must not be counted: it restates every label it clicks, so
  // counting it made EVERY label non-unique and selected nothing at all.
  const proseAll = mdx.replace(/<TestPlan\b[\s\S]*?<\/TestPlan>/g, " ").replace(/```[\s\S]*?```/g, " ");
  const labelCount = new Map();
  for (const m of proseAll.matchAll(/`([^`\n]{2,40})`/g)) labelCount.set(m[1], (labelCount.get(m[1]) || 0) + 1);

  const out = [];
  const OPEN = "<NumberedItem";
  for (let at = mdx.indexOf(OPEN); at !== -1; at = mdx.indexOf(OPEN, at + 1)) {
    // Balanced scan: a NumberedItem can hold Tabs and other components, so a non-greedy regex to the
    // first </NumberedItem> is right only by luck, and `[^>]*` on the open tag breaks on a `>` inside
    // a backticked title — the same bug that has bitten this codebase three times.
    let depth = 0, i = at, end = -1;
    while (i < mdx.length) {
      const nextOpen = mdx.indexOf(OPEN, i + 1);
      const nextClose = mdx.indexOf("</NumberedItem>", i + 1);
      if (nextClose === -1) break;
      if (nextOpen !== -1 && nextOpen < nextClose) { depth++; i = nextOpen; continue; }
      if (depth === 0) { end = nextClose; break; }
      depth--; i = nextClose;
    }
    if (end === -1) continue;
    const block = mdx.slice(at, end);
    if (!block.includes("<ThemeImage")) continue;

    // Labels from prose only: a fenced block's backticks are SQL identifiers, not controls.
    const prose = block.replace(/```[\s\S]*?```/g, " ");
    const labels = [...new Set([...prose.matchAll(/`([^`\n]{2,40})`/g)].map((m) => m[1]))]
      .filter((l) => labelCount.get(l) === 1);
    for (const img of block.matchAll(/<ThemeImage[^]*?light=\{(\w+)\}/g)) {
      const asset = imports.get(img[1]);
      if (asset) out.push({ asset, labels });
    }
  }
  return out;
}
