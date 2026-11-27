// The walk engine: drive the live Tiger Cloud Console through one extracted procedure, screenshot
// each step (compact, light/dark, masked), and return a structured pass/fail result. Lifted from
// the original 21-walk.mjs and made reusable so the entry point can run every procedure on a page.
//
// For destructive steps it runs the COMPLETE workflow where a clean-up exists (create a read
// replica set, then delete it); other destructive actions it stops before, since we have no
// safe undo for them.

import { chromium } from "playwright";
import { PROJECT_ID, STANDING_SERVICE_IDS } from "./services.mjs";
import { stripSqlLineComments, collapseSqlWhitespace, describeEditorMismatch } from "./sql-text.mjs";
export { PROJECT_ID };
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, existsSync, statSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { ensureFreshSession, landsOnLogin, loginAndSaveState, signIn } from "./auth.mjs";
import { stopRequested, stoppedLine } from "./stop.mjs";
import { ensureConnectionString, poolerEndpoint, serviceEndpoint } from "./fork.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const STATE = join(ROOT, ".auth", "state.json");
export const SHOTS = join(ROOT, "screenshots");

// The standing, dedicated test services (one per cloud) and their project come from .env via
// lib/services.mjs, so recreating one is an environment change and not a code change. Non-destructive
// steps run against the standing service directly; anything destructive needs a fork (see lib/fork.mjs).

// Null until the entry point has loaded the Cloud settings (lib/services.mjs requireCloud) and
// called setCloud: a self-hosted-only run never needs a standing service.
export let SERVICE_ID = null;
export function setCloud(cloud) {
  SERVICE_ID = STANDING_SERVICE_IDS[cloud] || STANDING_SERVICE_IDS.aws;
}
const servicesListUrl = () => `https://console.cloud.tigerdata.com/projects/${PROJECT_ID}/services`;
const overviewUrl = (id) => `https://console.cloud.tigerdata.com/projects/${PROJECT_ID}/services/${id}/overview`;
// Blur both clouds' standing IDs regardless of which is active this run — cheap and avoids any
// gap if a screenshot ever shows the other cloud's id incidentally. Read when a shot is taken, not
// at import: the ids are loaded by the entry point (lib/services.mjs).
const knownIds = () => [PROJECT_ID, ...Object.values(STANDING_SERVICE_IDS)].filter(Boolean);

// Test-input values live in the environment, never in the docs (a plan names them, see lib/plan.mjs):
// the annotation carries only a name, so nothing test-specific or personal is published.
const ENV_FILE = join(ROOT, ".env");
if (existsSync(ENV_FILE)) process.loadEnvFile(ENV_FILE);

export function testInputEnvVar(name) {
  return `DOCTEST_INPUT_${String(name).replace(/[^a-zA-Z0-9]+/g, "_").toUpperCase()}`;
}
function testInputValue(name) {
  const v = process.env[testInputEnvVar(name)];
  return v && v.trim() ? v.trim() : null;
}

// Type a supplied value into the field the step is asking about. Deliberately narrow: search the
// open dialog first (these steps almost always fill a modal, e.g. Add new user), and never a
// search box — the Console's header search is a visible text input on every page, so an unscoped
// "first text input" rule would quietly type into it and report success.
async function fillTestInput(page, value) {
  const dialog = page.locator('[role="dialog"]').filter({ visible: true });
  const scopes = (await dialog.count()) ? [dialog.first()] : [page.locator("main"), page];

  // A confirm dialog usually states the exact string it wants: 'Type "X" to confirm'. That
  // instruction is authoritative and beats any value we brought with us — the object's real name may
  // differ from what we think it is. (It did here: the row text ran the credential name straight
  // into its public key, so the name looked one character longer than it was, and the demanded
  // string was the only reliable source.) The submit button stays disabled until it matches exactly.
  if (await dialog.count()) {
    const text = ((await dialog.first().textContent()) || "").replace(/\s+/g, " ");
    const demanded = text.match(/type\s+["“']([^"”']+)["”']\s+to confirm/i);
    if (demanded) value = demanded[1];
  }
  for (const scope of scopes) {
    const inputs = scope.locator('input[type="email"], input[type="text"]:not([readonly]), input:not([type])').filter({ visible: true });
    const n = await inputs.count().catch(() => 0);
    for (let i = 0; i < n; i++) {
      const el = inputs.nth(i);
      const attrs = {
        name: (await el.getAttribute("name")) || "",
        placeholder: (await el.getAttribute("placeholder")) || "",
        aria: (await el.getAttribute("aria-label")) || "",
      };
      // Match on all three: a search box may be identified by any one of them.
      if (/search/i.test(`${attrs.name} ${attrs.placeholder} ${attrs.aria}`)) continue;
      if (!(await el.isEnabled().catch(() => false))) continue;
      if ((await el.inputValue().catch(() => "x")) !== "") continue;
      await el.fill(value);
      // Report ONE identifier, never the three concatenated. A field named `cidrBlocks[0].cidr`
      // whose placeholder is `10.0.0.0` produced "into cidrBlocks[0].cidr 10.0.0.0", which reads as
      // though 10.0.0.0 were the value typed -- indistinguishable, at a glance, from the false-pass
      // bugs this report exists to catch. The value itself is deliberately still not printed: a test
      // input can be a password.
      return attrs.aria.trim() || attrs.name.trim() || attrs.placeholder.trim() || "the field";
    }
  }
  return null;
}

// The Console's project-level sidebar: Services, Security, Exporters, Activity, Settings, CLI / MCP,
// Members, Billing, Support. A service page does not render this nav at all, so a procedure starting
// with one of these clicks cannot be walked from the service overview.
//
// Only labels with no service-level twin are listed: Security, Settings and Services also exist in a
// service's Operations nav, and treating those as project-scoped sends service-scoped procedures to
// the wrong starting page. Extend this only after confirming a label against the live Console.
//
// Scope itself is read from the URL, not from labels: labels drift (the Console pluralized its nav
// item to `IP Allow Lists` while the docs still said `IP Allow List`), and a per-procedure verdict
// cannot describe a procedure that crosses scopes, which real ones do.
//   /projects/<pid>/security/vpc                       -> project
//   /projects/<pid>/services/<sid>/operations/security -> service
export const SCOPE_PROJECT = "project";
export const SCOPE_SERVICE = "service";

export function currentScope(page) {
  return /\/services\/[^/]+\//.test(page.url()) ? SCOPE_SERVICE : SCOPE_PROJECT;
}

// Would a fork protect anything in this procedure? Only a destructive action that lands on the
// SERVICE can be isolated by forking, and whether one does is POSITIONAL: until the procedure says
// "select a service", every click is still at project scope. Asking "destructive anywhere?" and
// "touches a service anywhere?" separately over-fires on procedures whose destructive half IS the
// project half (transit-gateway, aws-privatelink), burning a fork that cannot protect what is being
// created. A mixed procedure still forks: an attach that follows the select is after it positionally.
//
// Two rules sit on top of the positional one:
//   - A MUTATING SQL statement counts wherever it appears. SQL runs against the target service, so a
//     CREATE TABLE lands in a real database whether or not a step said "select a service". Still
//     gated on the statement being destructive: a SELECT-only procedure must not burn a fork.
//   - VARIANTS ARE EVALUATED SEPARATELY. A tabbed procedure's variants are alternatives, so
//     flat-mapping them into one sequence splices together runs that never happen together, and
//     scope leaks across the seam.

// Where should this procedure START? Always the PROJECT view.
//
// This used to probe the live Console: walk the procedure's nav chain as far as it resolves, on the
// theory that an ambiguous label is never alone (`Security` exists at both scopes, but the docs go
// on to say `IP Allow Lists`, which exists only under the project). The probe was dropped because
// the answer it worked to compute doesn't change what the walker does: a procedure that needs the
// service view says "select a service", and acting on that navigates there anyway. Starting at the
// project is therefore correct for both kinds, and costs no round-trips to find out.
//
// Kept async and shaped as { scope, depth, tried, why } so the call sites and the report — which
// print the evidence rather than a bare boolean — keep working, and so a probe can come back here
// if a page ever turns up that genuinely needs one. `depth`/`tried` are empty: no chain was walked.
export async function resolveStartScope() {
  return { scope: SCOPE_PROJECT, depth: 0, tried: [], why: "default (select_service navigates to the service view when a procedure needs it)" };
}

// "Select the project you want to use" leaves the choice open, so pick any project that ISN'T the
// one we're already in — switching to the current project would prove nothing. Each entry in the
// open switcher carries data-cy="project-switcher-<name>" and its own project ID (confirmed live).
async function resolveProjectChoice(page) {
  const items = page.locator('[data-cy^="project-switcher-"]').filter({ visible: true });
  const n = await items.count();
  for (let i = 0; i < n; i++) {
    const item = items.nth(i);
    const text = (await item.textContent()) || "";
    if (text.includes(PROJECT_ID)) continue; // the project we're already in
    const label = ((await item.getAttribute("data-cy")) || "").replace("project-switcher-", "");
    return { locator: item, label: label || "another project" };
  }
  return null;
}

// Land on the project dashboard, where the project-level sidebar is rendered.
export async function gotoProject(page) {
  await page.goto(servicesListUrl(), { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.waitForTimeout(2500);
  return !landsOnLogin(page);
}

// Fill $NAME with DOCTEST_INPUT_NAME, for statements and commands.
//
// The same mechanism `type $INVITE_EMAIL` already uses, extended to SQL and shell so there is one
// way to carry a withheld value rather than two. A name with no value is left alone: resolveCommand
// then reports it as an environment value this run does not define, and the step is skipped with a
// reason instead of running with a literal "$POOLER_PASSWORD" in it.
export function applyTestInputs(text) {
  if (!text) return text;
  return text.replace(/\$([A-Z][A-Z0-9_]{2,})/g, (whole, name) => testInputValue(name) ?? whole);
}

// Substitute reader-supplied values for `<placeholder>` tokens before typing/running text.
export function applyInputs(text, inputs) {
  if (!text || !inputs) return text;
  return text.replace(/<([a-zA-Z][a-zA-Z0-9._ -]{2,40})>/g, (whole, name) => {
    const v = inputs[name.trim().toLowerCase()];
    return v != null ? v : whole;
  });
}

// ---- masking: blur the exact sensitive value (leaf elements / inputs), never a surrounding panel
// Values the run typed or ran itself are secrets too. `CREATE ROLE my_app LOGIN PASSWORD '…'` put the
// pooler password in the SQL editor in clear text, and the masker blurred connection strings and
// labelled keys but not a value it had supplied from DOCTEST_INPUT_POOLER_PASSWORD. Any test input
// whose name says password, secret, token or key is blurred wherever its value appears.
function secretTestInputValues() {
  return Object.entries(process.env)
    .filter(([k, v]) => /^DOCTEST_INPUT_.*(PASSWORD|PASSWD|SECRET|TOKEN|KEY)/i.test(k) && v && v.trim().length >= 6)
    .map(([, v]) => v.trim());
}

async function maskSensitive(page) {
  await page.evaluate(({ ids, secrets }) => {
    const host = /tsdb\.cloud\.timescale\.com|postgres(ql)?:\/\//i;
    // A 10-char id containing at least one digit. The digit is what keeps this from blurring
    // ordinary ten-letter English words, so it can't be dropped — but it also means an all-letter
    // service id (e.g. "dpvmcqimxn") sails through, which is why labelled ids are handled below.
    const idTok = /\b(?=[a-z0-9]*[0-9])[a-z0-9]{10}\b/;
    // A credential key has no label next to it in a list view (the label is a column header), and no
    // fixed shape to match -- so treat any long, unbroken, digit-bearing token as a key. Prose never
    // looks like this, and a published public key still identifies a real account. The digit is
    // required, as the comment above always claimed and the pattern did not enforce: Monaco renders
    // each SQL token in its own element, so `add_retention_policy` (20 characters, no digit) was
    // blurred in the editor and the evidence hid the very statement under test.
    const keyTok = /^(?=[A-Za-z0-9_-]*[0-9])[A-Za-z0-9_-]{20,}$/;
    // Real account emails identify people and appear all over the Console ("Issued by", member
    // lists). Doc screenshots must not publish them.
    const email = /\b[\w.+-]+@[\w-]+\.[\w.]{2,}\b/;
    const sensitive = (s) => !!s && (ids.some((id) => s.includes(id)) || secrets.some((v) => s.includes(v)) || host.test(s) || idTok.test(s) || keyTok.test(s.trim()) || email.test(s));
    const blur = (el) => { el.style.filter = "blur(7px)"; };

    for (const el of document.querySelectorAll("input, textarea, code, span, div, p, td, button, a")) {
      if (el.children.length > 0) continue; // leaf only
      const v = el.value || el.textContent || "";
      if (v.length <= 200 && sensitive(v)) blur(el);
    }

    // Secrets shown next to their own label. The client-credentials flow displays a live Secret Key
    // once and only once, and these screenshots end up in a shareable report — publishing a real
    // project credential would be a security incident, not a cosmetic slip. Blur by LABEL because a
    // key has no recognisable shape to match on.
    const secretLabel = /^(secret key|secret|public key|private key|password|token|access token|api key|client secret)$/i;
    for (const el of document.querySelectorAll("*")) {
      const label = (el.textContent || "").trim();
      if (!secretLabel.test(label)) continue;
      const scope = el.closest("tr,[role=row],div,section") || el.parentElement;
      if (!scope) continue;
      for (const leaf of scope.querySelectorAll("*")) {
        if (leaf.children.length > 0) continue;
        const t = (leaf.textContent || "").trim();
        if (t && !secretLabel.test(t) && t.length >= 8) blur(leaf);
      }
      for (const inp of scope.querySelectorAll("input, textarea")) blur(inp);
    }

    // Anything the UI itself labels as a service id, whatever its shape. Digit-free ids were
    // leaking into published screenshots, which defeats the point of masking at all: the reader
    // of a doc screenshot must never see a real service identifier.
    const idShape = /^[a-z0-9]{8,14}$/i;
    for (const el of document.querySelectorAll("*")) {
      const label = (el.textContent || "").trim();
      if (!/^service id$/i.test(label)) continue;
      // The value sits in a sibling/nearby leaf — walk the labelled container's leaves.
      const scope = el.parentElement || el;
      for (const leaf of scope.querySelectorAll("*")) {
        if (leaf.children.length > 0) continue;
        const t = (leaf.textContent || "").trim();
        if (t && t !== label && idShape.test(t)) blur(leaf);
      }
    }
  }, { ids: knownIds(), secrets: secretTestInputValues() });
}

// EVIDENCE screenshots: one theme, thorough. A run proves the docs match the product, and a theme
// difference is not a claim any page makes — capturing both doubled the output (168 images, 44 MB for
// one 69-step page) for pictures identical apart from colour. Docs-facing screenshots are a different
// job with different rules (both themes, few, framed for a reader) and get their own verb.
//
// DOCTEST_SHOTS=none turns them off. Measured cost is ~400 ms a shot, so on a 25-minute run this buys
// one or two minutes — it is for iterating on whether a plan parses and drives, not for CI. A passing
// run with no evidence is a claim, and distrusting claims is the whole point of the tool; the report
// says so when they are off.
// Named for the JOB, not for the settings: `evidence` (default) proves the docs match the product,
// `doc-update` produces images for the page itself, `none` runs blind.
const SHOT_MODE = process.env.DOCTEST_SHOTS || "evidence";
const SHOT_MODES = { evidence: ["light"], "doc-update": ["light", "dark"], none: [] };
if (!SHOT_MODES[SHOT_MODE]) {
  throw new Error(`DOCTEST_SHOTS must be one of ${Object.keys(SHOT_MODES).join(", ")} (got "${SHOT_MODE}")`);
}
const SHOT_SCHEMES = SHOT_MODES[SHOT_MODE];
export const SHOTS_DISABLED = SHOT_SCHEMES.length === 0;

// The colour scheme currently emulated. Re-applying it costs a 300 ms settle per shot for no change,
// which is most of a shot's measured cost in single-theme mode.
let appliedScheme = null;

// What screen are we looking at? Used by doc-update to shoot once per view instead of once per step:
// a docs image illustrates a SCREEN, and five steps filling in one wizard pane are one picture.
async function viewSignature(page) {
  return page
    .evaluate(() => {
      const dialog = document.querySelector('[role="dialog"],[aria-modal="true"]');
      const inDialog = dialog ? (dialog.querySelector("h1,h2,h3,[role=heading]")?.textContent || "").trim() : "";
      const heading = (document.querySelector("main h1, main h2, h1")?.textContent || "").trim();
      return `${location.pathname}|${inDialog.slice(0, 60)}|${heading.slice(0, 60)}`;
    })
    .catch(() => null);
}

async function shot(page, name, { schemes = SHOT_SCHEMES } = {}) {
  if (!schemes.length) return;
  await settle(page); // every screenshot waits for the page to settle (no in-progress spinners)
  const info = await page.evaluate(() => {
    document.querySelectorAll("[data-walkscroll]").forEach((e) => e.removeAttribute("data-walkscroll"));
    let best = null, bestO = 60;
    for (const el of document.querySelectorAll("*")) {
      const o = el.scrollHeight - el.clientHeight;
      const cs = getComputedStyle(el);
      if (o > bestO && /(auto|scroll)/.test(cs.overflowY) && el.clientHeight > 200) { best = el; bestO = o; }
    }
    if (!best) return null;
    best.setAttribute("data-walkscroll", "1");
    return { overflow: bestO, client: best.clientHeight, top: Math.round(best.getBoundingClientRect().top) };
  });
  const setScroll = (y) => page.evaluate((v) => { const e = document.querySelector('[data-walkscroll="1"]'); if (e) e.scrollTop = v; }, y);
  const fadeBand = (top, h) => page.evaluate(([tp, hh]) => {
    const bg = getComputedStyle(document.body).backgroundColor || "#fff";
    let o = document.getElementById("__walkfade");
    if (!o) { o = document.createElement("div"); o.id = "__walkfade"; document.body.appendChild(o); }
    o.style.cssText = `position:fixed;top:${tp}px;left:0;width:100%;height:${hh}px;z-index:2147483647;pointer-events:none;background:linear-gradient(to bottom,${bg} 0%,${bg} 12%,transparent 100%)`;
  }, [top, h]);
  const clearFade = () => page.evaluate(() => document.getElementById("__walkfade")?.remove());

  // Decide whether the below-the-fold area holds real content worth a second shot (a wizard's
  // remaining fields) vs. just whitespace (e.g. the SQL result page). Only tile when it does.
  let tileIt = false;
  if (info) {
    await setScroll(0);
    const below = await page.evaluate(() => {
      const sc = document.querySelector('[data-walkscroll="1"]');
      const bottom = sc.getBoundingClientRect().bottom;
      let c = 0;
      for (const el of sc.querySelectorAll("button,input,select,textarea,[role=button],h2,h3,h4,label")) {
        const cs = getComputedStyle(el);
        if (cs.position === "fixed" || cs.position === "sticky") continue;
        const r = el.getBoundingClientRect();
        if (r.width > 0 && r.height > 0 && r.top >= bottom - 12) c++; // starts at/below the fold
      }
      return c;
    });
    tileIt = below >= 1;
  }

  for (const scheme of schemes) {
    if (scheme !== appliedScheme) {
      await page.emulateMedia({ colorScheme: scheme });
      await page.waitForTimeout(300);
      appliedScheme = scheme;
    }
    if (!tileIt) {
      if (info) await setScroll(0);
      await clearFade();
      await maskSensitive(page);
      await page.screenshot({ path: join(SHOTS, `${name}-${scheme}.png`) });
    } else {
      const step = Math.floor(info.client * 0.86);
      const tiles = Math.min(6, Math.ceil(info.overflow / step) + 1);
      const STRIP = 150; // height of the soft fade-in at the top of a continuation shot
      let prev = 0;
      for (let t = 0; t < tiles; t++) {
        const cur = Math.min(t * step, info.overflow);
        if (t > 0 && cur === prev) break; // no new content below
        await setScroll(cur);
        await page.waitForTimeout(350);
        if (t === 0) {
          await clearFade();
          await maskSensitive(page);
          await page.screenshot({ path: join(SHOTS, `${name}-${scheme}-1.png`) });
        } else {
          const overlap = Math.max(0, info.client - (cur - prev));
          const cropTop = Math.max(0, Math.round(info.top + overlap - STRIP));
          await fadeBand(cropTop, STRIP);
          await maskSensitive(page);
          await page.screenshot({
            path: join(SHOTS, `${name}-${scheme}-${t + 1}.png`),
            clip: { x: 0, y: cropTop, width: 1280, height: Math.max(220, 860 - cropTop) },
          });
          await clearFade();
        }
        prev = cur;
      }
      await setScroll(0);
    }
  }
  await page.emulateMedia({ colorScheme: "light" });
}

// Wait for the page to settle before a screenshot: network idle + any transient indicator cleared.
// A ceiling on any await. Playwright's page.evaluate has NO default timeout, so one unresponsive
// page hangs a run forever: a 70-step run once sat on one step for 23 minutes at 0% CPU with
// no screenshot written, and the sequence that step runs was later timed at under a second on the same
// screen — so the stall was somewhere in the plumbing around it, not in the step. Chasing which call
// would fix one instance; a ceiling turns every future one into a reported failure and lets the rest of
// the page finish.
const STEP_CEILING_MS = Number(process.env.DOCTEST_STEP_CEILING_MS || 240000);

function capped(label, promise, ms = STEP_CEILING_MS) {
  let timer;
  return Promise.race([
    promise.finally(() => clearTimeout(timer)),
    new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${label} exceeded ${Math.round(ms / 1000)}s and was abandoned`)), ms); }),
  ]);
}

async function settle(page) {
  await page.waitForLoadState("networkidle", { timeout: 15000 }).catch(() => {});
  await page.getByText(/querying|loading|saving/i).first().waitFor({ state: "hidden", timeout: 25000 }).catch(() => {});
  await page.waitForTimeout(1200);
}

// The URL is project-scoped (/projects/<PROJECT_ID>/services/<id>/...), so navigating straight
// there lands on the right service regardless of whatever project was last active in this
// session — no project-switcher click needed. Retry once for a transient load hiccup.
export async function gotoServiceById(page, id) {
  await page.goto(overviewUrl(id), { waitUntil: "load", timeout: 60000 });
  await page.waitForTimeout(2500);
  if (!page.url().includes(id)) {
    await page.goto(overviewUrl(id), { waitUntil: "load", timeout: 60000 });
    await page.waitForTimeout(2500);
  }
  return page.url().includes(id);
}

export async function gotoService(page) {
  return gotoServiceById(page, SERVICE_ID);
}

// "New service" opens the creation wizard from the services LIST page — unlike every other click
// action, it does NOT assume we're already looking at a specific service. Navigate there explicitly
// rather than clicking whatever "New service" text might be visible on whatever page we're on.
//
// The wizard itself is 3 steps (Compute & Region -> Environment -> Name & Create) with a "Continue"
// button between them (data-cy="create-service-continue" on every step) before the final "Create
// service" button (data-cy="create-service-button") appears on step 3. The docs just say "follow
// the wizard" — an intentionally open-ended instruction, not a gap — so accept whatever is
// pre-selected on each step and advance until the submit button shows up.
async function goToNewServiceWizard(page) {
  await page.goto(servicesListUrl(), { waitUntil: "load", timeout: 60000 });
  await page.waitForTimeout(3000);
  await dismissCookies(page);
  // Click "+ New service" and wait for navigation to /create_services
  try {
    await clickLabel(page, "New service");
    await page.waitForURL(/\/create_services/, { timeout: 10000 });
  } catch (e) {
    // fallback: try data-cy button
    const openBtn = page.locator('[data-cy="create-service-expanding-button"]').first();
    await openBtn.click({ timeout: 10000 });
    await page.waitForURL(/\/create_services/, { timeout: 10000 });
  }
  await page.waitForTimeout(1500);

  for (let i = 0; i < 5; i++) {
    if (await page.locator('[data-cy="create-service-button"]').filter({ visible: true }).count()) return;
    const cont = page.locator('[data-cy="create-service-continue"]').filter({ visible: true }).first();
    if (!(await cont.count())) return; // no more steps to advance, or the wizard shape changed
    await cont.click({ timeout: 10000 });
    await page.waitForTimeout(1200);
  }
}


// Collapse the SQL editor if it's expanded: an open editor panel overlays the bottom of the page
// and occludes buttons. The collapse chevron is an unlabeled icon at the editor header's right edge.
export async function tidyState(page) {
  const editor = page.locator(".cm-content, .monaco-editor, textarea").first();
  if (!(await editor.isVisible().catch(() => false))) return;
  const title = page.getByText("SQL Editor", { exact: true }).first();
  const box = await title.boundingBox().catch(() => null);
  if (!box) return;
  await page.mouse.click(1238, Math.round(box.y + box.height / 2));
  await page.waitForTimeout(900);
}

// "Type `X`" means two quite different things depending on where we are: into the SQL editor, or into
// a form/confirmation field. The selector list only covered code editors and <textarea>, so
// "Type `Apply` in the confirmation popup" (a plain <input> in a Chakra dialog) matched nothing and
// spent Playwright's full timeout before failing — the last blocker on the IP allow list attach.
//
// A confirm dialog's own input wins when a modal is open: that is where the docs are pointing, and
// the SQL editor may still be mounted underneath.
async function typeInto(page, text) {
  const modal = await openModal(page);
  if (modal) {
    const field = modal.locator('input:not([type="hidden"]):not([type="checkbox"]):not([type="radio"]), textarea').filter({ visible: true }).first();
    if (await field.count()) {
      await field.click({ timeout: 10000 });
      await page.waitForTimeout(300);
      await field.fill(text);
      await page.waitForTimeout(400); // let the dialog re-validate and enable its confirm button
      return;
    }
  }
  const editor = page.locator(".cm-content, .monaco-editor textarea, textarea, [contenteditable='true']").filter({ visible: true }).first();
  if (await editor.count()) {
    await editor.click({ timeout: 10000 });
    await page.waitForTimeout(300);
    await page.keyboard.type(text);
    return;
  }
  throw new Error(`nothing to type "${text}" into — no modal field and no editor on the page`);
}

// Ensure the Console SQL editor panel is expanded. The "SQL Editor" header TOGGLES it, so only click
// when it's currently collapsed (idempotent) — otherwise a click would close an already-open editor.
// Fill the gaps a docs command leaves on purpose, from the ENVIRONMENT — the reader supplies their
// own connection details, and so does this tool. Returns { command } when every gap could be filled,
// or { skip } with the reason when one couldn't, because running a half-resolved command produces a
// failure that reads like a documentation bug.
//
// Resolvable:
//   a postgres:// URI containing <placeholders>   -> the target service's connection string
//   $TARGET                                       -> the target service's connection string
//   $SERVICE_URL_WITH_PORT                        -> host:port  (strict-ssl writes it this way)
// Not resolvable, and honestly reported rather than guessed at:
//   localhost / 127.0.0.1 targets  -> a database on the reader's machine that this run has not got
//   $SOURCE and friends            -> the reader's own source database in a migration
export function resolveCommand(command, { connection, endpoint, pooler }) {
  let out = command;
  if (/\b(?:localhost|127\.0\.0\.1)\b/.test(out)) {
    return { skip: "targets a database on the reader's own machine (localhost), which this run does not provide" };
  }
  // Substitution has to respect shell quoting. A connection string carries `?` (a glob) and can
  // carry `&` — and `psql $TARGET` with an unquoted `&` in the value would make the shell BACKGROUND
  // the process mid-URI. So a value that lands somewhere already quoted goes in bare, and anywhere
  // else it goes in single-quoted.
  const substitute = (str, re, value) =>
    str.replace(re, (match, offset) => {
      const before = str[offset - 1];
      const after = str[offset + match.length];
      // Quote ONLY when the placeholder is a whole shell word. A value that lands inside a bigger
      // token is already governed by that token's own quoting, and wrapping it again corrupts it:
      // the strict-SSL page's `psql "postgres://tsdbadmin@$SERVICE_URL_WITH_PORT/tsdb?..."` resolved
      // to `@'host:5432'/tsdb`, a URI carrying literal quote characters, because the old test looked
      // only at the single character each side and saw `@` and `/` rather than quotes.
      //
      // A bare word still gets quoted, which is the case that mattered originally: `psql $TARGET`
      // with an unquoted `&` in a connection string would background the process mid-URI.
      const isWholeWord = (before === undefined || /\s/.test(before)) && (after === undefined || /\s/.test(after));
      return isWholeWord ? `'${value}'` : value;
    });

  // BEFORE the connection rules, and that order is the whole point. The rule below replaces any
  // postgres:// URI containing a `<`, so an angle-bracket pooler placeholder inside one would be
  // swallowed and the command rewritten to the SERVICE connection string: different user, and the
  // service's port instead of the pooler's. It would connect, pass, and prove nothing about a
  // pooler. Filling the placeholders we can name exactly, first, leaves that rule to do what it is
  // for -- a URI whose gaps we cannot fill individually.
  //
  // Host and port are separate because the page asks the reader to paste them from the Console and
  // the repo writes that kind of gap as <HOST> and <PORT>. Only these two exact names are filled;
  // this is not the piecemeal URI reassembly the rule below exists to avoid.
  const namesPooler = /<\s*POOLER_(?:HOST|PORT)\s*>/i.test(out);
  if (namesPooler && !pooler) {
    // Skip, never fall through. Left unfilled these reach the rule below, which would rewrite the
    // whole URI to the SERVICE connection string -- so a run whose pooler was never created would
    // connect to the service, succeed, and report a passing pooler step.
    return { skip: "the service has no connection pooler, so there is no pooler host and port to connect to" };
  }
  if (pooler) {
    out = substitute(out, /<\s*POOLER_HOST\s*>/gi, pooler.host);
    out = substitute(out, /<\s*POOLER_PORT\s*>/gi, String(pooler.port));
  }
  // <HOST> and <PORT> are how house style writes the same gap ("every reader-supplied value is an
  // angle placeholder"). Filled BEFORE the whole-URI rule below, and that order matters: a documented
  // `postgres://tsdbadmin@<HOST>:<PORT>/tsdb?sslmode=verify-full` used to be replaced whole by the
  // service connection string, whose sslmode is `require`. The step then connected, passed, and had
  // exercised the opposite of what the page documents. With host and port filled first the URI has
  // no gap left, keeps its own query string, and authenticates through PGPASSWORD like any other.
  if (endpoint) {
    out = substitute(out, /<\s*HOST\s*>/g, endpoint.host);
    out = substitute(out, /<\s*PORT\s*>/g, String(endpoint.port));
  }
  if (connection) {
    // Replace a whole URI that STILL carries placeholders — piecemeal substitution of <user>,
    // <password> and the like would have to reassemble a URI, and getting that subtly wrong is how a
    // tool reports an authentication failure as a docs defect.
    out = substitute(out, /postgres(?:ql)?:\/\/[^\s"']*<[^\s"']*/gi, connection);
    // A placeholder that NAMES the connection, where the whole argument is the gap:
    // `psql "<your-service-url>"` on the create-service page. Matched by name because there is no
    // URI to pattern-match — this is the doc-intentional gap the environment is meant to fill, and
    // the docs are right not to print a real connection string. Deliberately narrow: <database-name>,
    // <table-name> and <password> are NOT connection strings and must keep skipping the step.
    out = substitute(
      out,
      /<\s*(?:your[-_ ]?)?(?:service[-_ ]?(?:url|uri)|(?:service[-_ ]?)?connection[-_ ]?string)\s*>/gi,
      connection
    );
    out = substitute(out, /\$TARGET\b|\$\{TARGET\}/g, connection);
  }
  if (endpoint) out = substitute(out, /\$SERVICE_URL_WITH_PORT\b|\$\{SERVICE_URL_WITH_PORT\}/g, endpoint.hostPort);
  const leftoverPlaceholder = out.match(/<[^>\s][^>]{0,60}>/);
  if (leftoverPlaceholder) return { skip: `needs a value the docs leave open: ${leftoverPlaceholder[0]}` };
  const leftoverVar = out.match(/\$\{?[A-Z][A-Z0-9_]{2,}\}?/);
  if (leftoverVar) return { skip: `needs an environment value this run does not define: ${leftoverVar[0]}` };
  return { command: out };
}

// Run a documented command. The plan quotes it, and the program is re-checked here so a change on
// either side cannot quietly widen what executes.
//
// `cwd` is the run's fixtures directory when the plan fetched anything. It matters for psql: `\COPY`
// is a CLIENT-side command reading a local relative path, so the two \COPY statements on
// tiger-cloud-essentials can only work if psql runs where the downloaded CSVs actually are.
// openssl joins psql and tiger for the strict-SSL page, whose two documented commands are read-only
// TLS handshakes against the service; it writes nothing the run does not own.
const SHELL_RUNNABLE = /^(?:psql|tiger|openssl)\b/;
// Leading `NAME=value` assignments, which set the environment for the program rather than being one.
// The connection-pooling page documents `PGPASSWORD=<PASSWORD> psql "…"`, and the allowlist read the
// assignment as the program name: the step was refused, and the refusal printed the assignment --
// password included -- into the report.
const ENV_PREFIX = /^\s*[A-Za-z_][A-Za-z0-9_]*=(?:"[^"]*"|'[^']*'|\S*)\s+/;
const withoutEnvPrefix = (c) => { let out = c.trim(); while (ENV_PREFIX.test(out)) out = out.replace(ENV_PREFIX, ""); return out; };

// `home`, when given, is the run's own temporary directory: a documented `~/.postgresql/root.crt`
// then resolves inside the run, so a plan can save a file where the page says and the command finds
// it, without the run ever reading or writing the account's real home directory.
async function runShellCommand(command, { timeoutMs = 120_000, cwd = undefined, pgPassword = null, home = null } = {}) {
  const program = withoutEnvPrefix(command);
  // Report the PROGRAM, never the raw first token: that token is the env assignment when there is
  // one, and printing it puts a credential in the report.
  if (!SHELL_RUNNABLE.test(program)) return { ok: false, error: `refusing to run: ${program.split(/\s+/)[0] || "(empty command)"}` };
  try {
    const { stdout, stderr } = await execFileP("/bin/sh", ["-c", command], {
      cwd,
      timeout: timeoutMs,
      maxBuffer: 8 * 1024 * 1024,
      // PGPASSWORD from the environment, not from the command text, so a documented URI that carries
      // no password still authenticates and no credential reaches the report. A command that sets its
      // OWN PGPASSWORD still wins: a shell assignment overrides what it inherits, which is what lets
      // the pooler step connect as a different role. Also why psql cannot use .pgpass here -- that is
      // keyed on host AND port, and a pooler answers on a different port from its service.
      env: { ...process.env, ...(pgPassword ? { PGPASSWORD: pgPassword } : {}), ...(home ? { HOME: home } : {}), PGCONNECT_TIMEOUT: "20", PAGER: "cat", PSQL_PAGER: "cat" },
    });
    return { ok: true, out: `${stdout || ""}${stderr || ""}`.trim() };
  } catch (e) {
    return { ok: false, error: (e.stderr || e.stdout || e.message || "").toString().trim().split("\n").slice(0, 3).join(" | ") };
  }
}

// Should a skipped step suggest an annotation? Only when the docs describe an INTERACTION the walker
// ought to have resolved and didn't. "Install psql", "print your recovery codes", "open a terminal" are
// prerequisites no browser was ever going to satisfy: they are correctly documented, correctly skipped,
// and nothing needs doing. Demanding an annotation for those turns an honest accounting of 165 steps
// into 165 pointless edits, and frames every unautomatable instruction as outstanding work.
const annotationHint = (text) =>
  UNTARGETABLE.test(text)
    ? ` Annotate it (test="manual" with requires=) or name the control the reader clicks.`
    : "";

// Quote a value for /bin/sh so it survives verbatim. JSON.stringify is NOT this: it emits a
// double-quoted string with newlines as the two characters backslash-n, and sh passes those through
// literally, so psql received `CREATE TABLE t (\n  a int\n);` on one line and answered
// `syntax error at or near "\"`. Every multi-line SQL statement routed through psql failed that way,
// and it went unnoticed because the pages exercised so far send one-liners (SELECT CURRENT_DATE;).
// Single quotes preserve newlines and every metacharacter; the only escape needed is a quote itself.
const shq = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;

// A connection string must never reach a report, a log line or a screenshot.
// Redact anything that identifies the infrastructure a run touched. A report is meant to be
// attachable to a PR or kept as a CI artifact, so it must not carry more than the verdict needs.
//
// The connection URI was the only thing redacted, which was inconsistent: a documented `psql`
// command has its URI scrubbed and then `\conninfo` prints the same host straight back out, and a
// Tiger Cloud hostname is <service>.<project>.tsdb.cloud.timescale.com — the project id in clear
// text. Also covers the bare ids, so a log line naming a service without a hostname is caught too.
export const scrubSecrets = (s) =>
  (s || "")
    // Zero or more prefix characters: a libpq keyword `password=…` inside a --connection string has
    // no prefix, and one-or-more let the EC2 walker's filled <PASSWORD> through into a report.
    .replace(/\b([A-Za-z0-9_]*(?:PASSWORD|PASSWD|SECRET|TOKEN))=(?:"[^"]*"|'[^']*'|\S+)/gi, "$1=[redacted]")
    .replace(/postgres(?:ql)?:\/\/[^\s"']+/gi, "postgresql://[redacted]")
    .replace(/\b[a-z0-9]{10}\.[a-z0-9]{10}\.tsdb\.cloud\.timescale\.com\b/gi, "[service].[project].tsdb.cloud.timescale.com")
    .replace(/\(address "\d{1,3}(?:\.\d{1,3}){3}"\)/gi, '(address "[redacted]")')
    // Only once a project is loaded: on a self-hosted-only run there is none, and a pattern built
    // from null would turn every "null" in a report (a not-null violation, a JSON value) into "[project]".
    .replace(PROJECT_ID ? new RegExp(`\\b${PROJECT_ID}\\b`, "g") : /(?!)/, "[project]"); // /(?!)/ never matches; /$^/ would match an empty string

// The INFORMATIVE lines of psql output. A blunt "first two lines" gave
// `current_date / --------------` — the column header and its rule, with the actual value cut off, so
// the report proved nothing had errored but never showed what came back. For a Console step a
// screenshot carries the result; psql has no screenshot, so the text has to carry it.
export function meaningfulOutput(out, max = 3) {
  const lines = (out || "")
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !/^[-+|\s]+$/.test(l)); // drop psql's rule lines (---+---) and blank padding
  return lines.slice(0, max).join(" | ");
}

// Returns whether the editor is actually open. It used to return nothing and swallow its own click
// failure, so a caller could not tell "expanded" from "this page has no SQL editor at all" — the
// latter then surfaced as a bare "locator.click: Timeout 10000ms exceeded" from the NEXT line.
async function openSqlEditor(page) {
  const isOpen = () =>
    page.evaluate(() => {
      const e = document.querySelector(".monaco-editor .view-lines");
      if (!e) return false;
      const r = e.getBoundingClientRect();
      return r.height > 20 && r.width > 20;
    });
  if (await isOpen()) return true;
  await page.getByText(/^SQL Editor$/i).first().click({ timeout: 8000 }).catch(() => {});
  // The panel mounts its Monaco editor after the bar is clicked, and on a fresh fork that can take
  // longer than the fixed 1.5 s this used to wait: four pages of the 2026-11-23 batch went red with
  // "no SQL Editor bar" while their step screenshots showed the bar. Poll for the editor instead.
  const deadline = Date.now() + 15000;
  for (;;) {
    if (await isOpen()) return true;
    if (Date.now() >= deadline) return false;
    await page.waitForTimeout(250);
  }
}

// The mirror of openSqlEditor. The editor is a bottom panel that, once opened, covers the lower half
// of whatever page is behind it AND stays open across navigation — the Console remembers the state,
// so a fresh page load does not clear it.
//
// That panel is the tool's own instrument, so leaving it over a form is the tool's mess rather than
// anything the docs got wrong. It cost three runs on tiger-cloud-essentials: `Change configuration`
// sits below the availability options on the High availability form, and with the panel open it was
// first reported as disabled and then as a click timeout — two signatures, one cause, and neither
// pointing at the real problem. Collapsed after every SQL step and once before the walk starts, so
// no later step can inherit it.
async function collapseSqlEditor(page) {
  const isOpen = () =>
    page.evaluate(() => {
      const e = document.querySelector(".monaco-editor .view-lines");
      if (!e) return false;
      const r = e.getBoundingClientRect();
      return r.height > 20 && r.width > 20;
    });
  if (!(await isOpen())) return true;
  // Same control that opens it: the "SQL Editor" bar toggles.
  await page.getByText(/^SQL Editor$/i).first().click({ timeout: 8000 }).catch(() => {});
  await page.waitForTimeout(1200);
  return !(await isOpen());
}

// Put the browser in a service view with the SQL editor open, which is all "connect to your service"
// means when the docs give no specific steps: the editor is reachable only from inside a service's
// own pages (the "SQL Editor" bar at the bottom), never from the project level.
async function connectToService(page, serviceId) {
  if (currentScope(page) !== SCOPE_SERVICE) {
    await gotoServiceById(page, serviceId);
    await page.waitForTimeout(1500);
  }
  if (await openSqlEditor(page)) return { ok: true };
  // Second attempt from a known-good starting point: a stale view (a deleted fork, a service page
  // that half-rendered) can leave the bar absent even inside /services/<id>/.
  await gotoServiceById(page, serviceId);
  await page.waitForTimeout(2000);
  if (await openSqlEditor(page)) return { ok: true };
  return { ok: false, error: `couldn't open the SQL editor in service ${serviceId} — the editor did not open within 15 s on ${page.url()}` };
}

// Run one SQL block in the Console SQL editor and report whether it succeeded. Detects failure via
// the editor's "Failed" status and captures the error message.
const execFileP = promisify(execFile);
const MOD = process.platform === "darwin" ? "Meta" : "Control";

// insertText still lets Monaco's auto-indent and auto-closing-bracket behavior fire for multi-line
// text with nested parens — confirmed live: cascading indent per line, plus a genuine extra stray
// `)`, on a block shaped like `CREATE TABLE x (...) WITH (...)`. Collapsing to one line sidesteps
// both (SQL doesn't care about whitespace outside string literals; inside one it is kept, and a line
// break inside one is refused) and was verified to insert byte-for-byte faithfully.
//
// A `--` line comment used to block the collapse, because flattening it would swallow everything
// after it. That left the text multi-line, and a multi-line write cannot be read back (
// Monaco's `.view-lines` are absolutely positioned, so innerText returns them out of visual order),
// so such a step FAILED rather than ran. Strip the comments instead. They mean nothing to the
// database, and once they are gone the statement collapses like any other.
//
// A dollar-quoted body still bails out: its internal formatting can be load-bearing and no comment
// handling changes that. Tagged bodies ($tag$...$tag$) go undetected, exactly as before.
//
// Exported for the same reason as writeIntoEditor below: a probe must exercise the real gate, not a
// reimplementation of it.
export function prepareSqlForInsert(sql) {
  if (/\$\$/.test(sql)) return sql;
  return collapseSqlWhitespace(stripSqlLineComments(sql));
}

// Replace a Monaco editor's contents, PACED and VERIFIED. Both callers need this and for the same
// reasons, found the hard way on the continuous-aggregate wizard:
//
//   - Paced. Firing click, select-all, Delete and insertText within a few milliseconds leaves the
//     editor's model and whatever the app derives from it out of step. On the wizard that produced an
//     aggregate followed by a React error boundary; DOCTEST_SLOWMO=400 was the only thing separating
//     a passing run from a failing one, and a settle AFTER the write did not help.
//   - Verified by polling, not by one sample. `.view-lines` holds only the lines Monaco has painted,
//     so a single read straight after the write reports a perfectly full editor as empty.
//
// Returns the text the editor was last seen holding, "" if it could not be read. A caller that gets
// something other than what it asked for must not treat the write as done: the SQL editor keeps the
// PREVIOUS statement when an insert misses, so running anyway executes the wrong statement and
// reports success.
export async function writeIntoEditor(page, lines, text) {
  const beat = () => page.waitForTimeout(Number(process.env.DOCTEST_EDITOR_BEAT_MS || 400));
  const norm = (v) => String(v).replace(/\s+/g, " ").trim();
  await lines.scrollIntoViewIfNeeded({ timeout: 8000 }).catch(() => {});
  await lines.click({ timeout: 10000 });
  await beat();
  await page.keyboard.press(`${MOD}+A`);
  await beat();
  await page.keyboard.press("Delete");
  await beat();
  await capped("insertText", page.keyboard.insertText(text), 8000);
  await beat();
  let seen = "";
  for (let t = 0; t < 20; t++) {
    seen = await lines.innerText().catch(() => "");
    if (norm(seen) === norm(text)) return seen;
    await page.waitForTimeout(250);
  }
  return seen;
}

// Exported so a probe can exercise the REAL editor path rather than a copy of it. Reimplementing
// this in a test script is how a checker ends up confidently measuring its own duplicate instead of
// the thing that ships.
export async function runSql(page, sql, serviceId = SERVICE_ID) {
  // SQL runs against a SERVICE, so get into that service's view first. A procedure built entirely
  // from SQL has no labelled click chain for the scope probe, so the walk sits at PROJECT level where
  // no SQL editor exists — which is how all three statements on the 5-minute quickstart failed with
  // nothing but a click timeout.
  let wanted;
  try {
    wanted = prepareSqlForInsert(sql);
  } catch (e) {
    return { ok: false, error: e.message };
  }
  const ready = await connectToService(page, serviceId);
  if (!ready.ok) return { ok: false, error: ready.error };
  const lines = page.locator(".monaco-editor .view-lines").first();
  let landed = await writeIntoEditor(page, lines, wanted);
  // The Console re-renders the service page when its table count changes: dropping the last table
  // collapses the SQL editor while the next statement is being typed, and the write lands in the
  // old editor. Reconnect (which re-expands the editor) and write once more before giving up.
  if (landed.trim() && landed.replace(/\s+/g, " ").trim() !== wanted.replace(/\s+/g, " ").trim()) {
    const again = await connectToService(page, serviceId);
    if (again.ok) landed = await writeIntoEditor(page, page.locator(".monaco-editor .view-lines").first(), wanted);
  }
  // Refuse to run a statement that is not the one asked for. An editor holding OTHER text holds the
  // previous step's statement, and running it would report a pass for SQL that never executed. An
  // editor that reads empty is the unpainted case, not proof of failure, so that one proceeds.
  if (landed.trim() && landed.replace(/\s+/g, " ").trim() !== wanted.replace(/\s+/g, " ").trim()) {
    return { ok: false, error: `the SQL editor still held different text after the write (${describeEditorMismatch(wanted, landed)}), so the statement was not run` };
  }
  await page.getByRole("button", { name: /^run$/i }).first().click({ timeout: 10000 });
  await page.getByText(/querying/i).first().waitFor({ state: "hidden", timeout: 60000 }).catch(() => {});
  await page.waitForTimeout(1200);
  const failed = await page.getByText(/^Failed$/).first().isVisible().catch(() => false);
  if (!failed) return { ok: true };
  // Scrape the real DB error from a visible text element (not <style>/<script>, not CSS), matching
  // PostgreSQL error phrasing. Excludes the Osano cookie widget's CSS blob that otherwise matches.
  const error = await page.evaluate(() => {
    const PG = /(does not exist|syntax error|ERROR:|violates|already exists|permission denied|out of range|invalid input|cannot |must be |is not |unrecognized|duplicate key|deadlock|could not|expected at least one row|expected no rows)/i;
    const el = [...document.querySelectorAll("p, span, div, code, pre, td")].find(
      (e) => e.children.length === 0 && e.offsetParent !== null && e.textContent.length < 300 && !e.textContent.includes("{") && PG.test(e.textContent)
    );
    return el ? el.textContent.trim().slice(0, 200) : "query failed (see screenshot)";
  });
  return { ok: false, error };
}

// Dismiss the Osano cookie-consent banner if present — it overlays the page (intercepting clicks)
// and its CSS blob pollutes text scraping. Best-effort, never fatal.
async function dismissCookies(page) {
  // Add an overall timeout to prevent hanging on the button queries
  await Promise.race([
    (async () => {
      for (const re of [/^accept all$/i, /^accept$/i, /^got it$/i, /^agree$/i, /close cookie preferences/i, /^close this dialog$/i]) {
        await page.getByRole("button", { name: re }).first().click({ timeout: 1200 }).catch(() => {});
      }
    })(),
    new Promise((_, reject) => setTimeout(() => reject(new Error("dismissCookies timeout")), 5000))
  ]).catch(() => {
    // Either completed or timed out; in either case, just proceed
  });
}

// Click a docs label robustly: exact accessible name -> exact text -> loose text, visible-only, retry.
// `within` scopes the search to one element (a table row) instead of the whole page — see
// resolveTestRow. Everything else is unchanged: roles first, then exact text, then loose text.
// While a modal drawer/dialog is open, only its contents are actionable — but the page BEHIND it is
// still in the DOM and still matches by text. On the IP allow list page that was fatal: the drawer's
// `Create IP Allow List` submit was disabled (the required CIDR was empty), while the page behind it
// had a button with the SAME label, so a whole-page search clicked the background one and the step
// was reported `✓ (ran on fork)` when nothing had been created. Two false passes in one procedure,
// and the report read greener than the failures it was hiding.
//
// Returns the open dialog to scope to, or null when there isn't one.
async function openModal(page) {
  // getByRole in the union, not just a '[role="dialog"]' CSS selector: that selector matches only an
  // EXPLICIT role attribute, so a native <dialog>, which carries the role implicitly, is invisible to
  // it. Cheap insurance rather than a fix for anything observed — measured against the Console's CSV
  // upload panel, the attribute selector finds it perfectly well (it does set role explicitly), so
  // this was NOT the cause of the upload failure it was first committed for. That was the upload
  // simply not having finished: the same file reports 77s to process. Keeping both is strictly wider
  // than either, and the next Console panel may well be a native <dialog>.
  const dlg = page
    .getByRole("dialog")
    .or(page.getByRole("alertdialog"))
    .or(page.locator('[role="dialog"], [role="alertdialog"]'))
    .filter({ visible: true });
  const n = await dlg.count().catch(() => 0);
  if (!n) return null;
  return dlg.last(); // a dialog can stack on a dialog (confirm over drawer); the last is on top
}

const escapeRegExp = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// Things a user can actually activate. Used for clickLabel's text fallback so a documented label is
// only ever clicked on a control, never on prose that happens to contain the same words.
const INTERACTIVE =
  'button, a, [role="button"], [role="tab"], [role="menuitem"], [role="option"], [role="link"], label, summary, [tabindex]:not([tabindex="-1"])';

// Exported so a probe can drive the SAME click path that ships, for the same reason runSql is. A
// probe that reimplements the click measures its own reimplementation: this one used getByText and
// died on an invisible <p>CSV</p> inside a collapsed card, on a step the real walker passes.
// A button that goes busy after its click (disabled, or a spinner inside it) has a request in
// flight, and the Console navigates on its own when that request returns. The fork form's
// `Fork service` on Azure takes longer than the walk's next step: three runs on 2026-11-23/24
// clicked `Services` mid-request, the Console then moved to its completion page over that click,
// and `expect url /services` failed for it. So wait for the clicked control to settle: it is
// enabled again, it is gone because the page moved on, or the URL changed under it.
async function settleBusyControl(page, loc) {
  const startUrl = page.url();
  const busy = async () => {
    const el = loc.first();
    if (!(await el.count().catch(() => 0))) return false;
    if (page.url() !== startUrl) return false;
    if (await el.isDisabled().catch(() => false)) return true;
    return (await el.locator('[role="progressbar"], svg[class*="spin"], [class*="animate-spin"]').count().catch(() => 0)) > 0;
  };
  await page.waitForTimeout(300);
  if (!(await busy())) return;
  const deadline = Date.now() + OBJECT_WAIT_MS;
  while (Date.now() < deadline && (await busy())) await page.waitForTimeout(500);
  // The request moved the page: let the new page finish loading before the next step clicks into
  // it. On 2026-11-24 the walk clicked the `Services` nav the moment the fork's completion page
  // took over, and the click landed on a page still rendering, so the list never opened.
  if (page.url() !== startUrl) {
    await page.waitForLoadState("load", { timeout: 15000 }).catch(() => {});
    await page.waitForTimeout(1500);
  }
}

export async function clickLabel(page, label, { within = null, role: onlyRole = null } = {}) {
  // An explicit `within` (a pinned row) always wins: it's a deliberate narrowing by the caller.
  const root = within || (await openModal(page)) || page;

  if (process.env.DEBUG_CLICKS) {
    // Check what's on the page
    const allTabs = await page.locator('[role="tab"]').all();
    const msg = `[CLICK] Looking for "${label}" - found ${allTabs.length} [role="tab"] elements on page`;
    appendFileSync("/tmp/debug-clicks.log", msg + "\n");
    for (let i = 0; i < Math.min(allTabs.length, 5); i++) {
      const text = await allTabs[i].textContent();
      appendFileSync("/tmp/debug-clicks.log", `[CLICK]   [${i}] tab text: "${text?.trim()}"\n`);
    }
  }

  // The bound and the rethrow guard MUST come from the same constant. They drifted apart once
  // (`attempt <= 2` against `if (attempt === 3)`), so the guard never fired, the catch below
  // swallowed every unresolvable click, and clickLabel RETURNED NORMALLY — reporting a green ✓ for a
  // control that does not exist. A plan's click steps stopped being evidence of anything.
  const ATTEMPTS = 2;
  for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
    try {
      // First try data-cy attribute for Chakra tabs (e.g. "monitoring-button")
      if (label === "Monitoring" || label === "Operations" || label === "Overview") {
        const dataCyLabel = label.toLowerCase() + "-button";
        const dataCyLoc = root.locator(`[data-cy="${dataCyLabel}"]`).filter({ visible: true });
        if (await dataCyLoc.count()) {
          await dataCyLoc.first().click({ timeout: 10000 });
          await page.waitForTimeout(1500);
          return;
        }
      }

      // Role order here matters: the Explorer's `Continuous Aggregates`
      // panel has an inner TAB named `Hypertables` and, in the sidebar, an object-type FILTER BUTTON
      // named `Hypertables`. The button rung matched first, so the run filtered the sidebar, stayed on
      // the aggregates panel, and then failed to find a wizard entry that only exists on the other tab
      // — 13 consecutive failures from one wrong control. A plan that knows which kind of control it
      // means says so (`click tab \`Hypertables\``), and that is what onlyRole carries. Reordering the
      // list instead would silently move every other ambiguous label on every page.
      for (const role of onlyRole ? [onlyRole] : ["button", "link", "tab", "menuitem"]) {
        const loc = root.getByRole(role, { name: label, exact: true }).filter({ visible: true });
        if (await loc.count()) {
          await loc.first().click({ timeout: 10000 });
          if (role === "button") await settleBusyControl(page, loc);
          // A tab click that doesn't select the tab left the walk on the previous panel while
          // reporting success. But some tabs (the service's `Operations`) NAVIGATE, so the element is
          // torn down and re-mounted, and aria-selected reads "false" for a moment on the new node —
          // asserting immediately failed a click whose every following step then succeeded. Poll for
          // the switch, and only re-click if it genuinely never happens.
          if (role === "tab") {
            let selected = false;
            for (let poll = 0; poll < 10 && !selected; poll++) {
              await page.waitForTimeout(500);
              selected = (await loc.first().getAttribute("aria-selected").catch(() => null)) !== "false";
            }
            if (!selected) {
              await loc.first().click({ timeout: 10000 });
              await page.waitForTimeout(1500);
              if ((await loc.first().getAttribute("aria-selected").catch(() => null)) === "false") {
                throw new Error(`clicked the \`${label}\` tab but it did not become selected`);
              }
            }
          }
          return;
        }
      }
      // A role-restricted click is a claim about WHICH control the docs mean, so it fails here rather
      // than falling through to the rungs below and clicking a different kind of element — the exact
      // mistake it exists to prevent.
      if (onlyRole) throw new Error(`no ${onlyRole} labelled "${label}" on the page`);

      // Radios and checkboxes: the accessible name is the whole label, which usually starts with
      // the documented word and then explains it ("MFA Members must sign in using..."), so match
      // non-exactly. And like the Chakra switch, the input itself is a 1x1 element inside the
      // label — click the label.
      for (const role of ["radio", "checkbox", "switch", "option"]) {
        const loc = root.getByRole(role, { name: label, exact: false }).filter({ visible: true });
        if (await loc.count()) {
          const el = loc.first();
          const lab = el.locator("xpath=ancestor::label[1]");
          await ((await lab.count()) ? lab.first() : el).click({ timeout: 10000 });
          return;
        }
      }
      // Text fallback, but ONLY onto something interactive. The old last resort was
      // getByText(label, {exact:false}).click(), which on the service Security panel matched the
      // sentence "Choose VPC Peering, Private Endpoints, or IP Allow Lists to control and isolate
      // connections" — clicking a PARAGRAPH. That succeeds, changes nothing, and gets reported as a
      // green ✓, so the tab never switched and the next step hunted for a control that was never
      // shown. Any click target the docs name is a control; prose that merely mentions it is not.
      for (const re of [new RegExp(`^\\s*${escapeRegExp(label)}\\s*$`), new RegExp(escapeRegExp(label))]) {
        const hit = root.locator(INTERACTIVE).filter({ visible: true }).filter({ hasText: re });
        if (await hit.count()) { await hit.first().click({ timeout: 10000 }); return; }
      }
      // An EXACT text match is safe to click even when the element carries no role or tabindex. The
      // prose bug was specifically the NON-EXACT rung matching a label inside a sentence ("…or IP
      // Allow Lists to control…"); an element whose entire text is the label is a control the app
      // styled itself, not prose — no paragraph's full text is exactly "SQL Editor". Banning this too
      // broke the SQL editor header, a div with a click handler and nothing else.
      const exact = root.getByText(label, { exact: true }).filter({ visible: true });
      if (await exact.count()) { await exact.first().click({ timeout: 10000 }); return; }
      // Nothing matched YET. The rungs above all use count(), which answers instantly, whereas the
      // old prose fallback was a click() — and click() auto-waits up to 10s for its target. Dropping
      // it therefore removed the only wait in this function and broke every label on a slow-painting
      // page (`New service`, `Create service`, `Download the config`, `SQL Editor` all failed while
      // being perfectly real controls, because goToNewServiceWizard gives the services list just
      // 2.5s). So make one waiting attempt on an interactive match before giving up.
      try {
        await root
          .locator(INTERACTIVE)
          .filter({ visible: true })
          .filter({ hasText: new RegExp(escapeRegExp(label)) })
          .first()
          .click({ timeout: 10000 });
        return;
      } catch {
        // Only now is it fair to say what's wrong — and to say WHICH thing is wrong, rather than
        // asserting the text is present without having looked.
        const onPage = await root.getByText(label, { exact: false }).filter({ visible: true }).count();
        throw new Error(
          onPage
            ? `"${label}" appears on the page but not on any interactive control`
            : `no control labelled "${label}" on the page`
        );
      }
    } catch (e) {
      if (attempt === ATTEMPTS) throw e;
      // A control can be missing because the page is BUSY, not because the docs are wrong: an import
      // still running replaces its `Run` button with queue progress. Wait for the transient badge to
      // clear before spending the next attempt, rather than retrying twice in 5s against a job that
      // takes minutes.
      if (await statusBadge(page, TRANSIENT_BADGE)) await waitUntilStatusClears(page, { timeout: BUSY_WAIT_MS });
      else await page.waitForTimeout(2500);
    }
  }
  // Unreachable: the last attempt rethrows. Here so that if the loop is ever restructured again, a
  // click that resolved nothing fails loudly instead of quietly passing.
  throw new Error(`could not click "${label}" and did not report why`);
}

// Glyphs the docs use for a row's overflow menu. None of them exist as DOM text — the control is an
// SVG button with no accessible name — so they can only be resolved structurally.
const MENU_GLYPH = /^[⋮⋯…⁝]+$/;
// A control whose label says download. Worth resolving specially rather than annotating away: the
// config file is how every reader gets their connection credentials, so if that button broke, the
// docs would strand people at step one — and it is currently tested nowhere.
const DOWNLOAD_LABEL = /\bdownload\b/i;

// Anything that looks like a secret gets its VALUE replaced, keeping only the field name. The
// downloaded config is a credentials file, so the artifact this tool keeps has to be safe to sit in a
// working directory and safe to paste into a report — the screenshots are masked for exactly this
// reason, and a plaintext password file next to them would undo that.
const SECRETISH = /^(\s*(?:export\s+)?[\w.\-]{1,40})(\s*[:=]\s*)(.+)$/;
export const DOWNLOADS = join(SHOTS, "downloads");
export function saveRedactedDownload(prefix, stepIndex, suggestedName, tmpPath) {
  mkdirSync(DOWNLOADS, { recursive: true });
  const raw = readFileSync(tmpPath);
  const sha256 = createHash("sha256").update(raw).digest("hex");
  // Treat as text only if it really is: a NUL byte means binary, and redacting binary is nonsense.
  const isText = !raw.includes(0);
  const fields = [];
  let body;
  if (isText) {
    body = raw
      .toString("utf8")
      .split("\n")
      .map((line) => {
        if (/^\s*[#;]/.test(line)) return line; // comments carry no values
        // A bare connection string is handled FIRST: it contains the password inline, and it also
        // happens to look like `key: value` to the matcher below, which would file it under a field
        // called "postgresql".
        const urlMasked = line.replace(/postgres(?:ql)?:\/\/\S+/gi, "postgresql://[redacted]");
        if (urlMasked !== line) return urlMasked;
        const m = SECRETISH.exec(line);
        if (!m) return line;
        fields.push(m[1].trim().replace(/^export\s+/, ""));
        return `${m[1]}${m[2]}[redacted]`;
      })
      .join("\n");
  } else {
    body = `[binary file, ${raw.length} bytes, not transcribed]\n`;
  }
  const safe = `${prefix}-step${stepIndex + 1}-${suggestedName}`.replace(/[^\w.\-]/g, "_");
  const out = join(DOWNLOADS, `${safe}.redacted.txt`);
  writeFileSync(
    out,
    `# Redacted transcript of a file this run downloaded.\n` +
      `# original name: ${suggestedName}\n# bytes: ${raw.length}\n# sha256: ${sha256}\n` +
      `# Values are removed on purpose: the original is a credentials file.\n\n${body}`
  );
  return { name: suggestedName, bytes: raw.length, sha256, fields, redactedPath: out };
}

// Current state of a switch/checkbox, however it's implemented.
async function switchChecked(locator) {
  const aria = await locator.getAttribute("aria-checked").catch(() => null);
  if (aria != null) return aria === "true";
  return await locator.isChecked().catch(() => false);
}

const switchesIn = (page) => page.locator('[role="switch"], input[type="checkbox"]').filter({ visible: true });

// Snapshot every visible switch on the page, so a step annotated test="restore-after" can be put
// back exactly as it was once the procedure finishes.
async function snapshotSwitches(page) {
  const sw = switchesIn(page);
  const n = await sw.count().catch(() => 0);
  const states = [];
  for (let k = 0; k < n; k++) states.push(await switchChecked(sw.nth(k)));
  return { url: page.url(), states };
}

// The Console has MORE THAN ONE dropdown implementation, and a resolver that knows only one reports
// a perfectly clickable, correctly documented control as missing:
//
//   - react-select (the Members role selector): no native <select> at all, the visible value lives in
//     a "-singleValue" element, the clickable surface is the "-control" container, and options only
//     enter the DOM once it is open — so state has to be read from text.
//   - a plain Chakra <select> (the IP-allow-list attach control on a service): real <option>s, value
//     readable directly, no click needed to enumerate.
//   - a button with aria-haspopup opening a role=menu/listbox.
//
// Knowing only the first is what made "Select the list in the drop-down and click `Apply`" fail:
// dropdownIn found nothing, nothing was selected, `Apply` stayed (correctly) disabled, and the page
// was marked FAIL on a step the docs got right.
async function choiceControl(scope) {
  const native = scope.locator("select").filter({ visible: true }).first();
  if (await native.count()) return { kind: "native", el: native };
  const reactSelect = scope.locator('[class*="-control"]').filter({ visible: true }).first();
  if (await reactSelect.count()) return { kind: "react-select", el: reactSelect };
  const combo = scope
    .locator('[role="combobox"], [aria-haspopup="listbox"], [aria-haspopup="menu"]')
    .filter({ visible: true })
    .first();
  if (await combo.count()) return { kind: "combobox", el: combo };
  return null;
}

// What IS on the page, for the failure message. A bare "no dropdown found" means probing the live
// Console by hand to answer a question the tool was standing right next to.
async function describeChoiceCandidates(scope) {
  const counts = [];
  for (const [name, sel] of [
    ["<select>", "select"],
    ["react-select", '[class*="-control"]'],
    ["combobox/haspopup", '[role="combobox"], [aria-haspopup="listbox"], [aria-haspopup="menu"]'],
    ["radio", "input[type=radio]"],
  ]) {
    const n = await scope.locator(sel).filter({ visible: true }).count().catch(() => 0);
    if (n) counts.push(`${n} ${name}`);
  }
  return counts.length ? `visible candidates: ${counts.join(", ")}` : "no select, react-select, combobox or radio visible";
}

export async function dropdownValue(scope) {
  const native = scope.locator("select").filter({ visible: true }).first();
  if (await native.count()) {
    const txt = await native.locator("option:checked").first().textContent().catch(() => null);
    return (txt || "").trim() || null;
  }
  const v = scope.locator('[class*="-singleValue"]').first();
  if (await v.count()) return ((await v.textContent()) || "").trim() || null;
  // The Monitoring filters (Logs' severity list, Insights' time range) render their CURRENT value as
  // the react-select placeholder, not as a singleValue, so without this they read as "no value": the
  // step then picked the first option, which was the value already showing, and reported a change
  // from `null`.
  const p = scope.locator('[class*="-placeholder"]').first();
  return (await p.count()) ? ((await p.textContent()) || "").trim() || null : null;
}

// The drop-down a page names, for "select another option in `Severity type`". Returns a scope
// choiceControl can search, or null. Two ways a page can point at one, matching how the Console
// labels them:
//
//   - by the caption printed above it (Logs' SEVERITY TYPE, Insights' SHOW RESULTS FROM): the first
//     choice control after that text in document order is its own — the caption sits above its control,
//     so the next filter's control comes later;
//   - by the value it shows (the Jobs timeline's `Last 24 hours` has no caption at all): the
//     react-select whose visible value is that text, or a menu button carrying it as its name.
//
// The caption compares case-insensitively on leaf elements: the Console upper-cases captions in CSS
// and a page writes them the way a reader sees them, and either may win. The scope handed back is the
// control's PARENT, because choiceControl and dropdownValue search descendants.
const CHOICE_XPATH = 'self::select or contains(@class,"-control") or @role="combobox" or @aria-haspopup="listbox" or @aria-haspopup="menu"';
const CHOICE_CSS = 'select, [class*="-control"], [role="combobox"], [aria-haspopup="listbox"], [aria-haspopup="menu"]';

// Pin a found control by its POSITION among the page's choice controls, and hand back its parent.
// A locator built from the control's shown value ("the react-select showing `Last 24 hours`") stops
// matching the moment the value changes, which is exactly when selectOtherOption reads it back: the
// Jobs timeline step changed 24 hours to 12, read `null` after, and reported the change as a failure.
// The index does not move when a value does.
async function pinChoiceControl(page, control) {
  const target = await control.elementHandle({ timeout: 5000 }).catch(() => null);
  if (!target) return null;
  const all = page.locator(CHOICE_CSS);
  const idx = await all.evaluateAll((els, t) => els.indexOf(t), target).catch(() => -1);
  return idx < 0 ? null : all.nth(idx).locator("xpath=..");
}

async function dropdownNamed(page, name) {
  const lower = JSON.stringify(name.toLowerCase());
  // Matched on the text node, for the reason the `type` handler gives: the Console likes to print a
  // row of captions as bare text nodes in one container, and an element match sees only the first.
  // A text node INSIDE a react-select is that control's own shown value, not a caption, and its
  // "following" control would be the next drop-down along; those are left to the shown-value rung.
  const byCaption = page
    .locator(
      `xpath=//text()[translate(normalize-space(.),"ABCDEFGHIJKLMNOPQRSTUVWXYZ","abcdefghijklmnopqrstuvwxyz")=${lower}` +
      ` and not(ancestor::*[contains(@class,"-control")])]` +
      `/following::*[${CHOICE_XPATH}][1]`
    )
    .filter({ visible: true });
  if (await byCaption.count().catch(() => 0)) return pinChoiceControl(page, byCaption.first());
  // The value a react-select shows is its singleValue, or its placeholder when the Console renders
  // the current choice that way (the Monitoring filters do).
  const shown = page.locator('[class*="-singleValue"], [class*="-placeholder"]').filter({ hasText: name }).filter({ visible: true });
  if (await shown.count().catch(() => 0)) {
    const control = shown.first().locator('xpath=ancestor::*[contains(@class,"-control")][1]');
    if (await control.count().catch(() => 0)) return pinChoiceControl(page, control.first());
  }
  const button = page
    .locator('[aria-haspopup="listbox"], [aria-haspopup="menu"], [role="combobox"]')
    .filter({ hasText: name })
    .filter({ visible: true });
  if (await button.count().catch(() => 0)) return pinChoiceControl(page, button.first());
  return null;
}

// Pick an option that differs from the current one, or a specific one when `want` is given. Returns
// { before, after, chosen }. "Select another role" leaves the choice open on purpose: any different
// value demonstrates the step, and which values exist depends on the member and the account.
//
// `avoid` lists options this run already picked from the same drop-down. "Select the new region"
// after deleting a backup means a DIFFERENT region from the first one; without this the second pick
// saw the placeholder again and chose the first region a second time (Tokyo twice, 2026-09-25).
// When every option has been used, any different one is still better than failing.
export async function selectOtherOption(page, scope, { want = null, avoid = [] } = {}) {
  const before = await dropdownValue(scope);
  const control = await choiceControl(scope);
  if (!control) {
    return { before, after: before, chosen: null, error: `no dropdown found — ${await describeChoiceCandidates(scope)}` };
  }

  // A native <select> needs no opening click, and its options are readable up front. Picking by
  // VALUE (not label) because selectOption matches on value, and an attach dropdown's placeholder
  // ("Choose an IP Allow List") is itself an option with an empty value that must never be chosen.
  if (control.kind === "native") {
    const opts = await control.el.locator("option").evaluateAll((os) =>
      os.map((o) => ({ value: o.value, label: (o.textContent || "").trim(), selected: o.selected }))
    );
    const pick = want
      ? opts.find((o) => o.value && !o.selected && o.label === want)
      : opts.find((o) => o.value && !o.selected && !avoid.includes(o.label)) || opts.find((o) => o.value && !o.selected);
    if (!pick) {
      const offered = opts.map((o) => o.label || "(blank)").join(", ");
      return {
        before, after: before, chosen: null,
        error: want ? `option "${want}" not offered (offered: ${offered})` : `no selectable option offered (offered: ${offered})`,
      };
    }
    await control.el.selectOption(pick.value, { timeout: 10000 });
    await page.waitForLoadState("networkidle", { timeout: 15000 }).catch(() => {});
    await page.waitForTimeout(1500);
    return { before, after: await dropdownValue(scope), chosen: pick.label };
  }

  await control.el.click({ timeout: 10000 });
  await page.waitForTimeout(1500);

  // A combobox may open a role=menu of menuitems rather than a listbox of options.
  const options = page.locator('[role="option"], [role="menu"] [role="menuitem"]').filter({ visible: true });
  const n = await options.count();
  let chosen = null;
  let fallback = null;
  for (let i = 0; i < n; i++) {
    const text = ((await options.nth(i).textContent()) || "").trim();
    // Option text is "Admin" plus a description, so compare on the leading word.
    const name = text.split(/\s{2,}|(?<=[a-z])(?=[A-Z])/)[0].trim();
    if (want ? name !== want : before && name === before) continue;
    if (!want && avoid.includes(name)) {
      if (fallback === null) fallback = { i, name };
      continue;
    }
    await options.nth(i).click({ timeout: 10000 });
    chosen = name;
    break;
  }
  if (!chosen && fallback) {
    await options.nth(fallback.i).click({ timeout: 10000 });
    chosen = fallback.name;
  }
  if (!chosen) {
    await page.keyboard.press("Escape").catch(() => {});
    return { before, after: before, chosen: null, error: want ? `option "${want}" not offered` : "no different option offered" };
  }
  await page.waitForLoadState("networkidle", { timeout: 15000 }).catch(() => {});
  await page.waitForTimeout(2000);
  return { before, after: await dropdownValue(scope), chosen };
}

// Visible list rows, as text. Used to spot the row a create step just added: a procedure that
// creates something and then acts on it ("click the ⋮ menu and select Rename credentials") gives the
// tool no way to name that row -- the Console generates the name. Diffing before and after the
// create is the only honest way to know WHICH row is ours, and it matters: the real project holds
// ten other credentials, and an unpinned ⋮ would be a coin flip over someone else's.
async function rowTexts(page) {
  return await page.evaluate(() =>
    [...document.querySelectorAll('[role="row"], tr')]
      .filter((r) => { const b = r.getBoundingClientRect(); return b.width > 0 && b.height > 0; })
      .map((r) => (r.textContent || "").replace(/\s+/g, " ").trim())
      .filter(Boolean)
  );
}


// The row a testRow step must act on: the one containing the test value we own. Returns null rather
// than falling back to the whole page — a step like "next to the person you want to remove, click
// ⋮ > Remove" acting on an unidentified row would hit whoever happens to sit in the list, and the
// real project has real people in it. No row, no action.
export async function resolveTestRow(page, value) {
  const rows = page.locator('[role="row"], tr').filter({ visible: true }).filter({ hasText: value });
  if (await rows.count()) return rows.first();
  return null;
}

// A "read replica set" row (e.g. "expand and click the read replica set under your primary
// service") is a per-user, dynamically-named target — its own generated name, not something the
// docs can quote. Navigate to Read scaling (idempotent — harmless if already there) and click the
// row structurally, by its data-cy attribute, rather than by name. A plain `a[href*="/dashboard/
// services/"]` is NOT enough — that matches the whole left-nav rail too (every nav item links back
// to the current service), and .first() grabbed the top nav breadcrumb instead of the replica row.
async function selectReplicaRow(page) {
  await clickLabel(page, "Operations");
  await page.waitForTimeout(1000);
  await clickLabel(page, "Read scaling");
  await page.waitForTimeout(1500);
  const link = page.locator('[data-cy="table-row-0-cell-name"] a').filter({ visible: true }).first();
  await link.click({ timeout: 10000 });
}

// "Hover over the value you want to change and click the edit icon" (Database parameters) — same
// shape as selectReplicaRow: structural, no backtick label, because the docs deliberately leave
// WHICH parameter and WHAT new value open (any numeric one works). Confirmed live: the edit button
// (aria-label "edit") only renders on :hover, unlike the standing "trash" icon, which needs none —
// so this can't reuse resolveIconTarget() as-is. The revealed input carries no min/max attributes;
// the row's own "<min> to <max>" range text is the only place that lives, so read it from there.
async function editParameterValue(page, param = null) {
  // A named parameter can sit on a tab the page does not mention (the standby delays are under
  // `Advanced parameters`, confirmed live 2026-09-25), so narrow the grid with its own search box
  // rather than guessing a tab.
  if (param) {
    const search = page.getByPlaceholder("Search parameters").filter({ visible: true });
    if (await search.count().catch(() => 0)) { await search.first().fill(param); await page.waitForTimeout(1500); }
  }
  // This isn't a real <table> — Chakra UI div-grid with role=row/cell and literal "tr"/"td" class
  // names (confirmed live), same data-cy convention as listReadReplicasOf's "-cell-name" rows.
  const valueCell = (param
    ? page.locator('[role="row"]').filter({ hasText: param }).locator('[data-cy$="-cell-value"]')
    : page.locator('[data-cy$="-cell-value"]')
  ).filter({ hasText: /^-?\d+$/ }).filter({ visible: true }).first();
  // The search filters only the open tab ("Sorry, no search results" on Common parameters for the
  // standby delays, which live under Advanced parameters), so try the grid's other tabs.
  if (param && !(await valueCell.count().catch(() => 0))) {
    const tabs = page.getByRole("tab", { name: /parameters$/i }).filter({ visible: true });
    for (let k = 0; k < (await tabs.count().catch(() => 0)) && !(await valueCell.count().catch(() => 0)); k++) {
      await tabs.nth(k).click({ timeout: 5000 }).catch(() => {});
      await page.waitForTimeout(1200);
    }
  }
  if (param && !(await valueCell.count().catch(() => 0))) return { name: param, missing: true };
  // Pin the row element now: the value cell's text changes during the edit, so re-resolving the
  // locator afterwards could land on a different row.
  const rowEl = await valueCell.evaluateHandle((el) => el.closest('[role="row"]') || el.parentElement);
  await valueCell.hover();
  await page.waitForTimeout(300);
  const editBtn = page.getByRole("button", { name: "edit", exact: true }).filter({ visible: true }).first();
  await editBtn.click({ timeout: 10000 });
  await page.waitForTimeout(500);

  const input = page.locator('input[name="value"]').filter({ visible: true }).first();
  const current = await input.inputValue();
  // Read the range from its OWN cell. The row's joined textContent runs the empty unit column ("-")
  // into the minimum, so "25 to 105" read as "-25 to 105" and the tool typed -25 into
  // max_connections, which the grid flagged "Out of range" while the step reported a value in range
  // (read-scaling, 2026-09-25).
  const cells = await input.locator('xpath=ancestor::*[@role="row"][1]').locator('[role="cell"], [role="gridcell"], td').allInnerTexts().catch(() => []);
  const rangeCell = cells.map((c) => c.trim()).find((c) => /^-?\d+\s*to\s*-?\d+$/.test(c)) || "";
  const range = rangeCell.match(/^(-?\d+)\s*to\s*(-?\d+)$/);
  const num = Number(current);
  const next = range && num >= Number(range[2]) ? Number(range[1]) : num + 1;
  await input.fill(String(next));
  // The page says "clicking anywhere outside of that field saves the value to be applied", and it
  // means it: a Tab press left the field focused with the new value unsaved, `Apply changes` greyed
  // out and no `Restart required` badge (customize-configuration, 2026-09-18). Click the panel's own
  // heading, which is inert, and wait for the pending-change badge to render.
  await page.getByText("Database configuration", { exact: true }).first().click({ timeout: 5000 }).catch(() => page.keyboard.press("Tab"));
  await page.waitForTimeout(1200);
  const rowText = (await rowEl.evaluate((r) => r.textContent).catch(() => "")) || "";
  const name = param || (cells[0] || "").trim().split(/\s+/)[0] || "a parameter";
  return { name, current, next, outOfRange: /out of range/i.test(rowText) };
}

// A destructive click can create a resource (e.g. a read replica set) that isn't immediately
// usable — the Console shows a transient status like "Queued"/"Provisioning" for a while first.
// The click itself often lands on an unrelated transitional screen (e.g. a generic "creation
// complete" splash), not the page that actually shows the new resource's status — that page is
// usually reached by a LATER step (the docs' own "go check it" navigation). So rather than waiting
// right after the click, we check opportunistically at the end of EVERY subsequent step: the first
// time we land on a page that shows a status word at all, poll there until it clears.
async function bodyText(page) {
  return page.evaluate(() => document.body.innerText).catch(() => "");
}

// A status BADGE, not the word in a sentence. Returns the badge's text, or null.
//
// Testing the whole page body for queued/provisioning/creating matched prose on the
// continuous-aggregate wizard, polled for ten minutes, and marked a step `blocked` where nothing was
// provisioning. Which text matched was never established, so the fix does not depend on knowing:
// require an element whose ENTIRE text is the status word, the way clickLabel requires a control
// rather than a sentence mentioning one. On timeout the badge text is reported, so a recurrence
// names itself. The service overview's `Ready` badge is still found, so the discharge path holds.
async function statusBadge(page, words) {
  return page.evaluate((src) => {
    const rx = new RegExp(`^(?:${src})\\s*(?:\\.\\.\\.|…)?$`, "i");
    for (const el of document.querySelectorAll("span,div,p,td,th,strong,em,b,small,li,dd")) {
      if (el.children.length) continue; // leaves only: a wrapper inherits its child's text
      const t = (el.textContent || "").trim();
      if (!t || t.length > 24 || !rx.test(t)) continue;
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) continue;
      return t;
    }
    return null;
  }, words).catch(() => null);
}

// `in queue` and friends are the CSV import panel's states. A second import queues behind the
// first, and while it waits the panel shows queue progress INSTEAD of its `Run` button, so a
// documented `click Run` reports a missing control and the assertion that follows reads an empty
// table. The whole-text rule in statusBadge is what makes adding these safe: no paragraph's
// entire text is "In Queue". `running` is the CSV import panel's state since the 2026-11 Console
// (the heading over its progress bar); the 2026-11-23 batch saw essentials fail `click Run` against
// it with no wait at all.
// `pending retry` is the same panel after the importer lost its database connection mid-load
// (2026-11-24, 10.4M of 10.77M rows): it retries on its own, so a `Run` that is missing then is not
// missing yet.
const TRANSIENT_BADGE = "queued|in queue|provisioning|creating|importing|processing|uploading|running|pending retry";
const READY_BADGE = "ready";

// Assumes the caller already confirmed a transient status badge is present. Polls until it is gone,
// or gives up after `timeout`. Returns the badge text still showing on timeout, so the report can
// name what it waited for instead of leaving the reader to guess which word matched.
// Ten minutes is the budget for a SERVICE coming up (a fork takes about six). It is absurd for a
// database object, and it was being spent on one: the continuous-aggregate wizard shows a status word
// on its review screen, so a plan that had created something earlier sat there for the full timeout —
// twice, because two call sites each had their own budget. A step that creates a view now waits 90
// seconds at most, and only a procedure that creates a service gets the long one.
const SERVICE_WAIT_MS = 600000;
const OBJECT_WAIT_MS = 90000;
// How long a control may be missing because the page is busy. Deliberately longer than
// OBJECT_WAIT_MS: this covers a data import, and the sample dataset on tiger-cloud-essentials is
// 10.7M rows, which outlasts any budget sized for an object appearing in a list.
const BUSY_WAIT_MS = Number(process.env.DOCTEST_BUSY_WAIT_MS || 300000);
// How long `expect label` / `expect no label` keep looking before failing. Long enough for a service
// to finish pausing or resuming, and under STEP_CEILING_MS so the step's own ceiling is never what
// ends the wait.
const EXPECT_LABEL_WINDOW_MS = Number(process.env.DOCTEST_EXPECT_LABEL_WINDOW_MS || 180000);

// Status words the Console puts on a SERVICE (its own card and header) rather than on an object in
// a list: a replica being added, a service being provisioned. Those take the service budget however
// the wait was entered. On 2026-11-24 the essentials HA change still read `Processing` after the
// 2 min object budget, three steps went "blocked" for it, and every one of them had in fact worked.
const SERVICE_LEVEL_BADGE = /^(processing|provisioning|creating)\b/i;
// psql's wording for an endpoint that exists but is not serving yet.
const NOT_READY_YET = /server closed the connection unexpectedly|connection refused|could not connect to server|connection reset by peer|the database system is starting up/i;

async function waitUntilStatusClears(page, { timeout = OBJECT_WAIT_MS, interval = 5000 } = {}) {
  const start = Date.now();
  let last = null;
  while (Date.now() - start < timeout) {
    last = await statusBadge(page, TRANSIENT_BADGE);
    if (!last) return { cleared: true };
    if (SERVICE_LEVEL_BADGE.test(last) && timeout < SERVICE_WAIT_MS) timeout = SERVICE_WAIT_MS;
    await page.waitForTimeout(interval);
  }
  return { cleared: false, badge: last, waitedMs: Date.now() - start };
}

// An icon-only step ("Click the trash icon next to a replica set") has no backtick label, but the
// icon usually has an accessible name in the DOM. Each entry maps a keyword in the step's title to
// the icon's actual aria-label, and is tried only when backtick extraction found nothing.
//
// Resolution is not gated on running against a fork — a settings cog or expand chevron is not
// destructive — only the CLICK is: an entry marked `destructive` goes through the same
// stop-before-mutating protection as any other destructive action.
//
// `ariaLabel` may be a literal or a pattern; a pattern covers the Console's "Edit <thing>" naming
// with one entry. An entry resolves by accessible name, or by a stable data-cy selector where the
// control has no name at all. Every value here is confirmed against the live Console, not guessed.
const ICON_LABELS = [
  { keywords: /\btrash\b/i, ariaLabel: "Delete", destructive: true },
  { keywords: /\bpencil\b|\bedit icon\b/i, ariaLabel: /^edit\b/i, destructive: false },
  // "Click the link icon next to the replica": the HA replica row's connection-info button, an
  // icon-only button whose accessible name is "Connection info" (confirmed live 2026-09-25 on an HA
  // replica, svg data-icon-name actions/Link/Link).
  { keywords: /\blink icon\b/i, ariaLabel: "Connection info", destructive: false },
  // "click the arrows next to the project name in the top left" — the project switcher. No
  // accessible name, so it can only be found structurally.
  { keywords: /\barrows\b/i, selector: '[data-cy="main-nav-project-switcher"]', destructive: false },
];

// Step phrasing the walker can resolve structurally even with no backtick label in sight. Kept at
// module scope so the walk-time gate and the testability predicate below can never disagree about
// what this tool is actually able to do.
const UNTARGETABLE = /\b(click|select|choose|drag|toggle|press|check|uncheck|expand|collapse|turn\s+(?:on|off)|switch\s+(?:on|off))\b/i;
// "Connect to your service" with no specific steps of its own. Connecting, for the purposes of these
// docs, means being in that service's view with the SQL editor open — there is nothing else to do,
// and no connection string or client is involved. Only consulted when the step resolved NO actions:
// a step that names its own controls ("click `Connect`", "select `psql`") is followed as written.
// ANCHORED at the start, and the object must be the reader's own service. A looser version matched
// two things it must not: "Take the applications that connect to the source database offline" (the
// opposite of connecting) and "Connect to a database on your PostgreSQL instance" (a self-hosted psql
// step, which opening the Console SQL editor would satisfy in name only). Hence the determiner list
// excludes "a", and the phrase has to lead the title.
const CONNECT_TO_SERVICE = /^connect(?:ing)?\s+to\s+(?:your|the|this)\s+(?:tiger\s+cloud\s+)?(?:service|database)\b|^connect\s+to\s+it\b/i;
// Points at a row of live data rather than a fixed label.
const LIST_TARGET = /\b(?:in|from)\s+the\s+(?:\w+\s+){0,2}(?:list|table)\b/i;
// "Select the project you want to use" — which project is deliberately left open.
const PROJECT_CHOICE = /\b(?:select|choose)\b[^\n]*\bproject\b/i;

// A step can still be actionable with no labelled control: an unlabeled icon, or an open choice like
// "select the project you want to use". The resolvers below handle those by phrasing, and are
// deliberately narrow — only shapes this file can genuinely act on.

async function resolveIconTarget(page, title) {
  for (const { keywords, ariaLabel, selector, destructive } of ICON_LABELS) {
    if (!keywords.test(title || "")) continue;
    if (selector) {
      const byCy = page.locator(selector).filter({ visible: true });
      // Reported as a selector, not an aria-label: this control has no accessible name at all, and
      // the step log should say how it was really found.
      if (await byCy.count()) return { locator: byCy.first(), selector, destructive: !!destructive };
      continue;
    }
    // Playwright's `exact` applies to string names only; a pattern is matched as given.
    const byName =
      typeof ariaLabel === "string"
        ? page.getByRole("button", { name: ariaLabel, exact: true })
        : page.getByRole("button", { name: ariaLabel });
    const btn = byName.filter({ visible: true });
    if (await btn.count()) {
      const first = btn.first();
      // Report the control's real accessible name, never the pattern that matched it, so the
      // step log says what was actually clicked.
      const resolved = (await first.getAttribute("aria-label").catch(() => null)) || String(ariaLabel);
      return { locator: first, ariaLabel: resolved, destructive: !!destructive };
    }
  }
  return null;
}

// "Click a job ID in the list to view its config and run history" names no specific target on
// purpose: any row works, and which rows exist depends on the service's own data. So this is a
// gap the docs leave deliberately, and the tool fills it from the environment rather than the
// docs growing a fake example ID that would rot. Resolve it the way a reader would: take the
// first row that drills into a direct child of the page we're already on (/monitoring/jobs ->
// /monitoring/jobs/1029, confirmed live: job IDs render as real links). Scoping to the current
// path is what keeps this deterministic and stops it wandering into unrelated navigation.
async function resolveListItemTarget(page) {
  const base = new URL(page.url()).pathname.replace(/\/+$/, "");
  const links = page.locator(`a[href^="${base}/"]`).filter({ visible: true });
  const n = await links.count();
  for (let i = 0; i < n; i++) {
    const link = links.nth(i);
    const href = (await link.getAttribute("href")) || "";
    const rest = href.slice(base.length + 1);
    if (!rest || rest.includes("/")) continue; // direct child only, not a deeper path
    const text = ((await link.textContent()) || "").trim();
    if (text) return { locator: link, label: text };
  }
  return null;
}

// Is every visible control matching this label disabled? (e.g., Apply when no change was made.)
// Used to tell "the docs step needs a value we didn't supply" apart from a genuine failure.
// Scoped to the open modal when there is one, for the same reason clickLabel is: with a drawer open,
// its disabled submit and an identically-labelled ENABLED button on the page behind it both match, so
// an unscoped `.every(disabled)` returns false and the real blocker is never reported.
async function isLabelDisabled(page, label) {
  const modal = await openModal(page);
  const scope = modal ? await modal.elementHandle().catch(() => null) : null;
  const result = await page.evaluate(
    ({ lab, root }) => {
      const container = root || document;
      const els = [...container.querySelectorAll("button,a,[role=button]")]
        .filter((e) => e.offsetParent !== null && e.textContent.trim().toLowerCase() === lab.toLowerCase());
      return els.length > 0 && els.every((e) => e.disabled === true || e.getAttribute("aria-disabled") === "true");
    },
    { lab: label, root: scope }
  );
  await scope?.dispose();
  return result;
}

// Anything transient the Console puts over the page: a dialog, a row's `⋮` menu, a select's list.
//
// openModal deliberately only knows dialogs, because everything built on it (confirm, presence
// assertions) is about dialogs. `dismiss` is about the menu case too, and a `⋮` menu is a
// [role=menu], so asking openModal would report "nothing open" with the menu plainly on screen.
async function openOverlay(page) {
  const dlg = await openModal(page);
  if (dlg) return { kind: "dialog", node: dlg };
  const menu = page.locator('[role="menu"], [role="listbox"]').filter({ visible: true });
  return (await menu.count().catch(() => 0)) ? { kind: "menu", node: menu.last() } : null;
}

// The switch a documented label refers to when the control carries no accessible name of its own.
//
// The Console renders `Enhanced authentication` as heading text with an unnamed toggle beside it, so
// getByRole("switch", {name}) finds nothing and the setting reads as absent from a page that plainly
// has it. These two rungs were already inside the `toggle` arm and are shared rather than copied:
// an assertion and the press it guards must agree on which control a label means, or a plan can
// assert one thing and toggle another.
async function switchNearLabel(page, label) {
  const near = page
    .locator(`xpath=//*[contains(normalize-space(text()),${JSON.stringify(label)})]/ancestor-or-self::*[1]//*[@role="switch" or (self::input and @type="checkbox")]`)
    .filter({ visible: true });
  if (await near.count()) return near.first();
  const all = switchesIn(page);
  return (await all.count()) === 1 ? all.first() : null;
}

// Is a control present, and can it actually be used? Three answers, never two.
//
// isLabelDisabled cannot be reused here: it returns false both when nothing matched and when
// something enabled matched, which is fine for its own job (telling a blocked click apart from a
// broken one) and would make an assertion pass on a control that is not on the page at all. That is
// the false-pass family this tool has been bitten by more than any other.
//
// Resolution goes through getByRole, the same way clickLabel does, rather than scanning textContent:
// a switch and a radio carry their name in aria-label with no text of their own, and `Enhanced
// authentication` is a switch. A hand-rolled text scan reported those absent — a failure that reads
// exactly like a docs bug. The role list is clickLabel's plus the state-bearing roles, since this
// assertion is used on controls a plan deliberately does not press.
const ASSERTABLE_ROLES = ["button", "link", "tab", "menuitem", "switch", "checkbox", "radio", "option"];

async function labelEnabledState(page, label) {
  // Polled, not asked once. count() resolves immediately, so an assertion that runs the instant the
  // previous click returns reports "absent" on a page that is merely still rendering. The Console's
  // Security section redirects twice on the way in and the walker waits 1500ms after a click, which
  // was not enough: `Enhanced authentication` was reported missing from a page that has it, off a
  // blank screenshot. A spurious failure costs as much as a spurious pass here, because both send
  // someone to look at the docs for a bug that is not in them.
  const deadline = Date.now() + 10000;
  for (;;) {
    // Scoped to whatever is on top, for the reason clickLabel is: with a `⋮` menu open, an
    // identically-labelled control on the page behind it is not the one the step means.
    const overlay = await openOverlay(page);
    const root = overlay ? overlay.node : page;
    for (const exact of [true, false]) {
      for (const role of ASSERTABLE_ROLES) {
        const loc = root.getByRole(role, { name: label, exact }).filter({ visible: true });
        if (!(await loc.count().catch(() => 0))) continue;
        const el = loc.first();
        // Both checks: Playwright's isEnabled only knows the native disabled property, and the
        // Console greys out menu items with aria-disabled, which is the case this verb exists for.
        const native = await el.isEnabled().catch(() => false);
        const aria = await el.getAttribute("aria-disabled").catch(() => null);
        return native && aria !== "true" ? "enabled" : "disabled";
      }
    }
    const sw = await switchNearLabel(page, label);
    if (sw) {
      const native = await sw.isEnabled().catch(() => false);
      const aria = await sw.getAttribute("aria-disabled").catch(() => null);
      return native && aria !== "true" ? "enabled" : "disabled";
    }
    if (Date.now() > deadline) return "absent";
    await page.waitForTimeout(500);
  }
}

// Some docs steps genuinely leave a choice open ("Choose your replication strategy, then click
// `Change configuration`") because any valid choice works — that's good docs, not a gap. The
// submit control (Apply/Change configuration/Change config) stays disabled until something
// actually changes. Resolve it the same way a human skimming the docs would: pick whichever
// radio option isn't already selected. Deterministic DOM rule, not a judgment call — never guesses
// a "best" option, just the first one that differs from the current state.
// Did the form REJECT what we just submitted? A submit click that trips client-side validation
// succeeds as a click — the button was enabled, Playwright clicked it, no exception — while the
// dialog stays open and nothing is created. That is indistinguishable from success unless the
// validation state is read explicitly, and on the IP allow list page it produced two green ✓ marks
// for a list that never existed. Returns the complaint text, or null if the form is happy.
async function formValidationError(page) {
  // The fallback scope was page.locator("main") — but this Console renders NO <main> and no
  // [role=main] anywhere (verified live on service, project and operations pages), so outside a modal
  // this function counted 0 and returned "no error" unconditionally. Every non-modal form rejection
  // was therefore invisible. Fall back to the whole page instead; the chrome holds no form errors.
  const scope = (await openModal(page)) || page;
  if (scope !== page && !(await scope.count())) return null;
  const invalid = scope.locator('[aria-invalid="true"]').filter({ visible: true });
  const hasInvalid = (await invalid.count()) > 0;
  // Chakra renders the message in a sibling element, not on the input, so read both signals.
  const messages = scope.locator(".chakra-form__error-message, [role='alert']").filter({ visible: true });
  const texts = [];
  for (let i = 0; i < (await messages.count()); i++) {
    const t = (await messages.nth(i).innerText().catch(() => "")).replace(/\s+/g, " ").trim();
    if (t) texts.push(t);
  }
  if (!hasInvalid && !texts.length) return null;
  if (texts.length) return texts.join("; ");
  // aria-invalid with no recognised message element. The IP allow list attach dialog is exactly this:
  // it renders 'You must type "APPLY" to confirm' in neither .chakra-form__error-message nor
  // [role=alert], so the report read "a required field was rejected" and the reader was left to guess
  // WHAT the form wanted. The dialog's own text says it — and that sentence is the finding, since it
  // is what tells a writer the docs' `Apply` should be `APPLY`. Quote it rather than paraphrase.
  const modal = await openModal(page);
  if (modal) {
    const raw = (await modal.innerText().catch(() => "")).replace(/\s+/g, " ").trim();
    if (raw) return `a field was rejected (aria-invalid); the dialog says: "${raw.slice(0, 240)}"`;
  }
  return "a required field was rejected (aria-invalid)";
}

async function resolveOpenChoice(page) {
  // This function clicks a control NOBODY NAMED — the docs deliberately left the choice open — so an
  // unscoped search is a loaded gun: the Console's chrome carries controls unrelated to the step.
  //
  // Unscoped, "click the first unchecked radio on the page" flipped the entire Console from Ops view
  // to Data view (PopSQL) when `Apply` was disabled on the IP-allow-list attach step. Verified in the
  // live DOM: div[data-cy=main-nav] holds a role=radiogroup whose two radios are value="ops"
  // (checked) and value="data" (unchecked) — present on EVERY page, form or not. Every later step then
  // ran against the query editor ("no modal field and no editor on the page"), and the account was
  // left in Data view for the next run. A wrong click that changes global UI state is worse than a
  // clean failure: it silently corrupts later runs.
  //
  // Scoping cannot be done with "main": the Console renders NO <main> and no [role=main] anywhere
  // (verified on service, project and operations pages). Scoping to those would have made this
  // function a no-op everywhere and regressed change-resources' CPU/Memory pick. So the rule is
  // expressed the only way the DOM allows: anywhere except inside the app chrome.
  const CHROME = "@data-cy='main-nav'";
  const dialog = page.locator('[role="dialog"]').filter({ visible: true }).last();
  const inDialog = (await dialog.count()) > 0;

  // isChecked() is read as a PROPERTY, not the attribute: React-controlled radios often carry no
  // `checked` attribute at all, so an XPath not(@checked) predicate would match the checked one too.
  const radios = inDialog
    ? dialog.locator('input[type="radio"]')
    : page.locator(`xpath=//input[@type='radio' and not(ancestor::*[${CHROME}])]`);
  const radioCount = await radios.count();
  for (let i = 0; i < radioCount; i++) {
    const r = radios.nth(i);
    if (!(await r.isVisible().catch(() => false))) continue;
    if (await r.isChecked().catch(() => true)) continue;
    await r.click({ force: true }).catch(() => {});
    await page.waitForTimeout(1000); // let the UI re-render (enable the submit control, recompute pricing) before the caller retries
    return true;
  }

  // A native <select> is a documented dropdown shape too — the attach control on a service's IP
  // Allow List tab is one, and knowing only react-select is what left `Apply` disabled with nothing
  // selected. Pick by value: the placeholder ("Choose an IP Allow List") is itself an option with an
  // empty value and must never be chosen.
  const selects = inDialog
    ? dialog.locator("select")
    : page.locator(`xpath=//select[not(ancestor::*[${CHROME}])]`);
  const selectCount = await selects.count();
  for (let i = 0; i < selectCount; i++) {
    const sel = selects.nth(i);
    if (!(await sel.isVisible().catch(() => false))) continue;
    const opts = await sel.locator("option").evaluateAll((os) =>
      os.map((o) => ({ value: o.value, selected: o.selected }))
    );
    const pick = opts.find((o) => o.value && !o.selected);
    if (!pick) continue;
    await sel.selectOption(pick.value, { timeout: 10000 }).catch(() => {});
    await page.waitForTimeout(1000);
    return true;
  }

  // react-select-style dropdown (e.g. the Compute and storage CPU/Memory picker): any class ending
  // "__control" is the trigger, opening a menu of "__option" items. Class prefixes vary per dropdown
  // instance, so match generically rather than hardcoding one dropdown's name.
  const control = (inDialog
    ? dialog.locator('[class*="__control"]')
    : page.locator(`xpath=//*[contains(@class,'__control') and not(ancestor::*[${CHROME}])]`)
  ).filter({ visible: true }).first();
  if ((await control.count()) === 0) return false;
  const currentText = await page.locator('[class*="__single-value"]').first().textContent().catch(() => null);
  await control.click({ force: true }).catch(() => {});
  await page.waitForTimeout(500);
  const options = page.locator('[class*="__option"]').filter({ visible: true });
  const optionCount = await options.count();
  for (let i = 0; i < optionCount; i++) {
    const text = await options.nth(i).textContent();
    if (text?.trim() !== currentText?.trim()) {
      await options.nth(i).click({ force: true }).catch(() => {});
      await page.waitForTimeout(1000);
      return true;
    }
  }
  await page.keyboard.press("Escape").catch(() => {}); // no different option found — close the menu, leave state unchanged
  return false;
}

// Remove a previous run's screenshots for this page prefix, so the report never mixes stale shots
// (e.g. an old non-tiled image alongside this run's tiled ones) into a step.
export function clearShots(prefix) {
  mkdirSync(SHOTS, { recursive: true });
  for (const f of readdirSync(SHOTS)) {
    if (f.startsWith(`${prefix}-`) && f.endsWith(".png")) rmSync(join(SHOTS, f));
  }
}

// List a specific service's own read replica set(s) (standbys), for teardown's discoverChildren.
// The Tiger CLI's `service list` omits standbys entirely, and — confirmed live — they don't appear
// on the main services list either (neither the old table UI nor the new card UI): a standby is
// only ever shown under its PARENT service's own "Read scaling" sub-page. So discovery has to be
// scoped per-parent, not a project-wide scan.
export async function listReadReplicasOf(page, serviceId) {
  await page.goto(`https://console.cloud.tigerdata.com/projects/${PROJECT_ID}/services/${serviceId}/operations/read-replicas`, { waitUntil: "load", timeout: 60000 });
  await page.waitForTimeout(2500);
  return [...new Set(await page.evaluate(() =>
    [...document.querySelectorAll('[data-cy$="-cell-name"] a')]
      .map((a) => (a.getAttribute("href").match(/\/services\/([a-z0-9]{10})\b/) || [])[1])
      .filter(Boolean)
  ))];
}

// Is this context actually logged in? Only the live Console can say (see lib/auth.mjs): stored
// state can look healthy after the server has invalidated it, and an unauthenticated walk doesn't
// fail loudly — it walks the login page and reports every step as a click timeout, which reads
// like a docs bug.
//
// Waits for domcontentloaded, NOT load: the services dashboard keeps firing XHRs, so waiting for
// full load times out on a slow moment and tells us nothing extra — the post-redirect URL is
// already the answer. A navigation timeout is inconclusive rather than fatal, so it reports
// "unknown" and lets the caller retry instead of aborting the run.
async function probeLoggedIn(page) {
  try {
    await page.goto(servicesListUrl(), { waitUntil: "domcontentloaded", timeout: 45000 });
  } catch {
    /* slow load says nothing about the session — fall through and judge by URL */
  }
  await page.waitForTimeout(2000);
  const url = page.url();
  if (!url || url === "about:blank") return "unknown";
  return landsOnLogin(page) ? "login" : "in";
}

// Launch a headless browser on the saved Console session, PROVING we're logged in before any
// procedure runs and repairing the session if we aren't. storageState is applied at
// context-creation time, so a repair means a fresh context, not just a reload.
export async function createSession() {
  mkdirSync(SHOTS, { recursive: true });
  // --disable-dev-shm-usage: use /tmp rather than a small /dev/shm for shared memory, the standard
  // guard against a Chromium that dies mid-session. A run holds one browser for 25 minutes across 70
  // steps, a 10.7-million-row upload page and dozens of screenshots, and one has died
  // outright at step 61 — no Chromium process left alive, node awaiting a dead socket.
  // DOCTEST_HEADED=1 shows the browser, and DOCTEST_SLOWMO=<ms> paces each action so a person can
  // follow it. Both are for watching a failure happen: a screenshot shows the state after a step, not
  // the interaction that produced it, and some failures here only make sense while they are moving.
  const headed = process.env.DOCTEST_HEADED === "1";
  // channel: "chromium" so headless and headed run THE SAME BINARY. Playwright's default headless is
  // `chrome-headless-shell`, the old headless implementation and a different build from the Chromium
  // that headed mode launches — and it is not merely invisible, it behaves differently. The
  // continuous-aggregate wizard creates the aggregate and then throws a React error boundary on the
  // way to its refresh-policy step under chrome-headless-shell, and completes the whole flow headed,
  // with the same statement, the same viewport and the same clicks. This channel selects full
  // Chromium in new-headless mode, so an unwatched run exercises what a watched one does.
  const browser = await chromium.launch({
    channel: "chromium",
    headless: !headed,
    slowMo: Number(process.env.DOCTEST_SLOWMO || 0),
    args: ["--disable-dev-shm-usage"],
    // Playwright's own signal handlers are off: by default SIGINT closes the browser and EXITS the
    // process, and SIGTERM/SIGHUP close the browser under the running step. Either skips or breaks the
    // teardown an interrupted run goes through (lib/stop.mjs); test-page.mjs closes the browser itself.
    handleSIGINT: false,
    handleSIGTERM: false,
    handleSIGHUP: false,
  });
  // deviceScaleFactor 2 quadruples the pixels of every screenshot: a 1280x860 viewport becomes a
  // 2560x1720 bitmap. Docs images want that; evidence does not — it is read on screen and it is the
  // one that runs 70 times a page. So retina only where the picture is the product.
  const newCtx = async () =>
    await browser.newContext({
      storageState: STATE,
      viewport: { width: 1280, height: 860 },
      deviceScaleFactor: SHOT_MODE === "doc-update" ? 2 : 1,
    });

  let context, page;
  const freshSessionAvailable = ensureFreshSession(STATE);
  if (process.env.DEBUG_AUTH) console.error(`[AUTH] Fresh session available: ${freshSessionAvailable}`);

  if (freshSessionAvailable) {
    context = await newCtx();
    page = await context.newPage();
    if (process.env.DEBUG_AUTH) console.error(`[AUTH] Probing logged-in state...`);
    let state = await probeLoggedIn(page);
    if (process.env.DEBUG_AUTH) console.error(`[AUTH] First probe result: ${state}`);
    if (state === "unknown") {
      state = await probeLoggedIn(page); // one retry for a genuinely slow Console
      if (process.env.DEBUG_AUTH) console.error(`[AUTH] Second probe result: ${state}`);
    }
    if (state === "in") {
      if (process.env.DEBUG_AUTH) console.error(`[AUTH] Session valid, using stored auth`);
      return { browser, context, page };
    }
    if (state === "unknown") {
      if (process.env.DEBUG_AUTH) console.error(`[AUTH] Timeout reaching Console`);
      await browser.close();
      throw new Error("Couldn't reach the Tiger Cloud Console to check the session (navigation kept timing out). Check connectivity and retry.");
    }
    if (process.env.DEBUG_AUTH) console.error(`[AUTH] Session invalid (redirected to login), need to re-login`);
    console.log("  Console session expired — logging in again...");
    await context.close();
  } else {
    if (process.env.DEBUG_AUTH) console.error(`[AUTH] No fresh session file`);
    console.log("  No usable Console session — logging in...");
  }

  await loginAndSaveState(STATE);
  context = await newCtx();
  page = await context.newPage();
  let after = await probeLoggedIn(page);
  if (after === "unknown") after = await probeLoggedIn(page);
  if (after !== "in") {
    await browser.close();
    throw new Error(
      after === "login"
        ? "Logged in but the Console still redirects to /login. If the account uses SSO, " +
          "email+password login can't work — check CONSOLE_EMAIL/CONSOLE_PASSWORD and the account's login method."
        : "Couldn't reach the Tiger Cloud Console after logging in (navigation kept timing out). Check connectivity and retry."
    );
  }
  return { browser, context, page };
}

// Walk ONE procedure against a target service. Options:
//   serviceId        which service the procedure runs against (the standing service, or a fork)
//   allowDestructive run destructive steps for real (true on a throwaway fork) vs. stop before them
//                    (false on the standing service, where we must not mutate state)
//   pendingCreate    true if an earlier procedure on this same fork created something whose
//                    readiness we never got to confirm (thread the return value's pendingCreate
//                    from one walkProcedure call into the next call's options, same fork)
// Returns { title, verdict: "pass"|"fail"|"stopped", actions, shots, pendingCreate }.
export async function walkProcedure(page, proc, prefix, { inputs = {}, serviceId = SERVICE_ID, allowDestructive = false, pendingCreate = false, startScope = null, serviceOwned = false, fixturesDir = null, failFast = false, docImages = [], nameCreated = null } = {}) {
  // Live-connection details, resolved lazily and at most once per procedure: most procedures never
  // need them, and each resolution is a CLI round trip. `serviceOwned` says whether this run owns the
  // target (a fork, or a service a page created), which is the only case where the tool may rotate a
  // password to get in — never the standing services.
  let connCache;
  let endpointCache;
  const connectionFor = async () => {
    if (awaitTargetUsable) await awaitTargetUsable();
    if (connCache === undefined) connCache = (await ensureConnectionString(serviceId, { owned: serviceOwned }).catch(() => null)) || null;
    return connCache;
  };
  // The service password, for psql to inherit. A documented pooler URI carries no password and
  // .pgpass cannot supply one (it is keyed on host AND port, and the pooler uses its own port), so
  // without this a pooler step stops on an interactive `Password for user tsdbadmin:` prompt.
  const pgPasswordFor = async () => {
    const c = await connectionFor();
    return c ? (decodeURIComponent(new URL(c).password || "") || null) : null;
  };
  const endpointFor = async () => {
    if (endpointCache === undefined) endpointCache = (await serviceEndpoint(serviceId).catch(() => null)) || null;
    return endpointCache;
  };
  // NOT cached like the endpoint: a plan adds the pooler partway through, so a null looked up before
  // that step would stick for the rest of the walk.
  const poolerFor = async () => (await poolerEndpoint(serviceId).catch(() => null)) || null;
  // Set once a documented psql connect has succeeded, so the SQL that follows in the same variant
  // runs through psql rather than the Console editor — the route the page actually documents.
  let psqlSession = null;
  // Set when a mid-procedure `Create service` retargets this walk at the service it just made.
  let retargeted = null;
  // Set alongside `retargeted`: the readiness wait, deferred until a step actually needs a live
  // database. Null when there is nothing to wait for, and nulled after it runs so it waits once.
  let awaitTargetUsable = null;
  // Start where the procedure actually begins, decided by probing the live Console (see
  // resolveStartScope) rather than by matching nav labels against a hand-kept list. The caller
  // probes first (it needs the scope to decide whether a fork is even useful) and passes the answer
  // in, so the probe's navigation happens once per procedure rather than twice.
  // A previous run, or a previous procedure, can leave the panel open. Clear it before the first
  // step rather than discovering it halfway through as an unreachable control.
  await collapseSqlEditor(page).catch(() => {});
  const start = startScope || (await resolveStartScope(page, proc, serviceId));
  // The plan says where it needs to be: a plan that needs the service view writes `select the
  // service`, and every plan starts at the project view until it does. A title heuristic used to
  // override that (`/connect|data|sql|read replicas|monitor/` on the procedure title meant "start on
  // the service"), left over from the prose extractor, which had no explicit step to go by. It sent
  // the connect page's plan, titled "Connect to Tiger Data", to the service Overview, where its first
  // step `click \`Settings\`` found nothing: the project tabs it was written to check were a page
  // away. Plans are explicit now, so the heuristic only ever contradicts them.
  const projectScoped = start.scope === SCOPE_PROJECT;

  if (projectScoped) await gotoProject(page);
  else await gotoServiceById(page, serviceId);
  await dismissCookies(page);
  await tidyState(page);

  // A step the ceiling abandoned keeps RUNNING: Promise.race rejects, but the handler behind it is
  // still awaiting Playwright, and when it finally returns it pushes its own verdict for the same
  // step. On the monitoring page step 28 was reported "exceeded 240s and was abandoned" and then, a
  // few lines later, "assertion held" for a query that returns no rows — a false pass printed
  // straight after the failure it contradicts. So the log drops any entry for a step already
  // abandoned, except the abandonment itself.
  const abandonedSteps = new Set();
  // The run's working directory: where documented commands run and write, and the home directory they
  // see. The fixtures directory when the plan fetched anything (psql's \COPY needs the CSVs there),
  // otherwise a fresh temporary directory. Either way it is the run's own, deleted with the fixtures
  // or by the OS, and never the account's real working or home directory: before this, a documented
  // `> bundle.crt` landed in whatever directory the tool was started from.
  const workDir = fixturesDir || mkdtempSync(join(tmpdir(), "doctest-work-"));
  // The most recent file the browser produced, for `save the download as …`. Cleared once saved, so a
  // later save cannot pick up an earlier step's file.
  let lastDownload = null;
  page.on("download", (d) => { lastDownload = d; });
  const actions = Object.assign([], {
    push(...items) {
      return Array.prototype.push.apply(
        this,
        items.filter((x) => !abandonedSteps.has(x.step) || /was abandoned$/.test(x.did || ""))
      );
    },
  });
  const shots = [];
  let stopped = false; // loop control: end the walk after a stop-before-destructive
  let haltedBeforeDestructive = false; // verdict: we deliberately did NOT run a destructive step
  // A destructive click's own screen rarely shows the created resource's real status (see
  // waitUntilStatusClears' comment) — check opportunistically at the end of every later step
  // instead, the first time we land on a page that shows a status word at all.
  let sawDestructiveCreate = pendingCreate;
  // A step waits for a status badge AT MOST ONCE: there are two call sites (after an action, and at
  // the end of the step) and each used to spend its own full budget on the same screen.
  let waitedThisStep = -1;
  // The long budget is only for a page that makes a SERVICE. Everything else is a database object or
  // a project resource, which appear immediately or not at all.
  const statusBudget = () => (hasCreateServiceStep ? SERVICE_WAIT_MS : OBJECT_WAIT_MS);
  // doc-update: which control label, when clicked, is the moment a published image illustrates.
  const docAssetByLabel = new Map();
  for (const m of docImages) for (const l of m.labels) docAssetByLabel.set(l, m.asset);
  let lastCapturedView = null;
  // Set when a "Create service" click creates a genuinely new, standalone service (not a mutation
  // of serviceId) — the caller must delete this specific resource too, separately from any fork.
  let createdServiceId = null;
  // Capture service list before procedure in case it creates a service
  let servicesBefore = new Set();
  // Every service that existed before this walk, minus the one it runs on. "Running on a fork" is a
  // property of the RUN, not of the page: on 2026-09-25 the read-scaling plan's "open the first row"
  // landed on the standing service from the services list, and the Compute and storage Apply that
  // followed resized the standing service while the report said "ran on fork". A destructive press
  // is now refused whenever the page belongs to one of these. Services the walk creates (a read
  // replica set, a recovery fork) are not in the set, so they stay drivable.
  const foreignServices = new Set();
  if (allowDestructive) {
    const { listServices } = await import("./fork.mjs");
    // Read replica sets are not top-level rows: each sits in its primary's `read_replica_sets`. Add
    // the other services' sets too, or a standing service's replica would slip past the guard.
    for (const svc of await listServices().catch(() => [])) {
      if (svc.service_id === serviceId) continue;
      foreignServices.add(svc.service_id);
      for (const rr of svc.read_replica_sets || []) if (rr.id) foreignServices.add(rr.id);
    }
  }
  const foreignServiceOnPage = (page) => {
    const m = page.url().match(/\/services\/([a-z0-9]{10})\b/);
    return m && foreignServices.has(m[1]) ? m[1] : null;
  };
  // Reads the step's ACTIONS. It used to test `s.action` on the step itself, which no step has, so it
  // was always false: the long provisioning budget never applied to the one page that needs it, and
  // the servicesBefore snapshot below — the leak check that caught a real billing service in August —
  // never ran either.
  //
  // One predicate, used both here and by the destructive guard below, so the two cannot drift into
  // disagreeing about what counts as creating a service.
  const isServiceCreation = (a) =>
    a.action === "create_service" || (a.action === "click" && /^create service$/i.test(a.label || ""));
  // Every reader of this used to test `action.createsService`, a flag NOTHING ever assigned. So the
  // whole create-a-service path was dead: the purpose-built [data-cy="create-service-button"]
  // selector never ran, the longer provisioning wait never applied, the before/after diff that
  // captures the new service's id never executed, and the report never said a service was made.
  // A run that did create one was caught only by the untracked-stray sweep at the end, and the
  // service was never adopted as the target for the steps after it.
  const hasCreateServiceStep = proc.steps.some((s) => (s.actions || []).some(isServiceCreation));
  if (hasCreateServiceStep) {
    const { listServices } = await import("./fork.mjs");
    const list = await listServices().catch(() => []);
    servicesBefore = new Set(list.map((s) => s.service_id));
  }
  // The name this walk gives a service it creates: `nameCreated()` (from test-page.mjs, which counts
  // across the page's procedures) hands out the next one. Typed over the wizard's default on its
  // final pane, so the new service is found by NAME afterwards and the end-of-run sweep deletes it
  // by name: a list diff alone cannot tell the page's service from one a person made in the project
  // at the same moment.
  let namedCreated = null; // the name typed for the creation in flight

  // A step whose title gives a UI instruction we couldn't turn into an action (e.g. "Click the trash
  // icon..." — an icon with no label) must NOT pass silently. Flag it so the procedure reads as
  // NEEDS INPUT rather than a false PASS that only did the surrounding navigation.

  const slugify = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

  // Row pinning, for steps a plan marks with testRow (see lib/plan.mjs). Reset per step.
  //   rowScope  the resolved row locator
  //   rowUsed   only the FIRST click is scoped to the row: a row's ⋮ menu and its confirm dialog
  //             render in portals OUTSIDE the row, so scoping later clicks would find nothing
  //   rowPinned the row resolved, so destructive clicks in this step are allowed even off a fork
  let rowScope = null;
  let rowUsed = false;
  let rowPinned = false;
  // The step index of a pin that found no row, so the step written for it is blocked too.
  let pinBlockedAt = -1;
  // Where the procedure WAS when the session died. A project-scoped procedure never says
  // "select the service", and returning it to the service view is how two members runs produced eight
  // failures each that read exactly like docs bugs: `Members` is a PROJECT tab, so on the service's
  // Overview page there is no such control, and every step after it failed the same way. The Console
  // reopens the last-visited service after login, so "wherever we land" is not good enough either.
  let serviceSelected = false;
  // Did anything in the current step (or tab) actually drive the PAGE? A terminal-only instruction --
  // a documented psql command, and the SQL that then runs through that psql session -- leaves the
  // browser untouched, so an end-of-step shot captures whatever was on screen beforehand and captions
  // it as this step. On create-service that produced a shot of the SQL-editor tab's leftover query,
  // labelled "psql on the command line". The report's action rows already say what psql did and what
  // it returned; a picture of a different route is worse than none. Set in runAction so every path
  // (a step's own actions, a tab's, anything added later) shares one rule.
  //
  // Two scopes, because the tab loop runs INSIDE a step: touchedBrowser is reset per tab and gates
  // that tab's shot, while stepTouchedBrowser accumulates over the whole step and gates the step's
  // own end-of-step shot. Sharing one variable would judge a step by its LAST tab, so a step that
  // clicked its way through a Console tab would lose its shot merely because psql is listed last.
  let touchedBrowser = false;
  let stepTouchedBrowser = false;
  const toggleRestores = []; // snapshots taken before test="restore-after" steps
  const dropdownRestores = []; // {pinValue, original} for dropdowns changed by a restore-after step
  // Options already picked per drop-down this walk, so a second "another option" really is another.
  const pickedOptions = new Map();
  let pinValue = null; // the test value the current step's row was pinned to
  let pinStep = -1; // the step index that pinned it, so an unused pin cannot outlive its procedure
  let createdRowText = null; // identifying text of a list row THIS procedure created

  // Run one action, whether from a step's own (non-tab) list or from one of its <Tabs>
  // alternatives. `tabLabel` is set only for the latter, so shots and log lines can be told apart
  // per tab at the same step index. Returns true if the walk must stop here (an unforked
  // destructive action on the standing service).
  async function runAction(action, i, tabLabel) {
    // 1-indexed to match the report and the captions: a file named -step10- IS report step 10.
    const stepBase = tabLabel ? `${prefix}-step${i + 1}-${slugify(tabLabel)}` : `${prefix}-step${i + 1}`;
    const tag = tabLabel ? `[${tabLabel}] ` : "";

    // `noted` is a step test-page.mjs already carried out (the fork, a download) rewritten into its
    // outcome. Handled before anything else so it cannot trip the destructive gate or screenshot an
    // unrelated page.
    if (action.action === "noted") {
      actions.push({ step: i, did: `${tag}${action.did}`, status: action.status || "ok" });
      return false;
    }
    // run_shell is a terminal command; run_sql with a live psqlSession is routed to that terminal too
    // (see the run_sql-and-psqlSession branch below). Everything else acts on the page. Same condition
    // the routing uses, read in the same place, so the two cannot drift apart.
    if (!(action.action === "run_shell" || (action.action === "run_sql" && psqlSession))) {
      touchedBrowser = true;
      stepTouchedBrowser = true;
    }
    // A destructive click normally requires a fork. A row-pinned step is the exception, and it has
    // to be: these are PROJECT-level actions, and a service fork can't isolate the project at all,
    // so waiting for fork protection here would mean never testing them. The safety comes from a
    // different place — the row is pinned to a value this tool owns (the invited test address), so
    // the action can only touch a resource we created, never a real member.
    // `Create service` is the one destructive click that needs no fork, and refusing it was a
    // deadlock. It CREATES a new standalone service rather than mutating an existing one, so there
    // is nothing for a fork to protect — and the whole lifecycle for it already exists: the
    // servicesBefore snapshot above, the capture below, then adoption as the target and deletion at
    // the end of the run in scripts/test-page.mjs, which also sweeps any service that appeared
    // untracked and refuses to delete a protected id.
    //
    // None of that could ever run. The guard stopped the click, so no service was created, so the
    // code that adopts and deletes one was unreachable, and create-service — the page whose whole
    // subject is this click — stopped at step 2 every time. Forking cannot help a page about
    // creating a service: a fork IS a service, made by a different route than the one documented.
    //
    // Creating a PROJECT-level resource is the third exception, for the same reason as the first:
    // `Create credentials` on the Settings page mutates no service, so a fork protects nothing, and
    // refusing it stopped the client-credentials plan at step 3 forever. Narrow on purpose: the word
    // is `create`, and the walk must be OFF a service page, because `Create a Continuous Aggregate`
    // on a standing service is exactly the mutation the gate exists for. What the plan creates it is
    // expected to remove itself, pinned to a value the run owns, as the members plan does.
    const projectLevelCreation = /\bcreate\b/i.test(action.label || "") && !/\/services\/[a-z0-9]{10}\b/.test(page.url());
    const foreign = action.destructive && allowDestructive ? foreignServiceOnPage(page) : null;
    if (foreign) {
      await shot(page, `${stepBase}-before-destructive`); shots.push({ base: `${stepBase}-before-destructive`, caption: `Step ${i + 1}: stopped before destructive action` });
      actions.push({ step: i, did: `${tag}STOP before destructive: "${action.label || "run SQL"}" — the page is on service ${foreign}, not this run's ${serviceId}`, status: "fail" });
      haltedBeforeDestructive = true;
      return true;
    }
    if (action.destructive && !allowDestructive && !rowPinned && !isServiceCreation(action) && !projectLevelCreation) {
      // Not on a fork: never mutate the standing service. Stop right before, capture the state.
      await shot(page, `${stepBase}-before-destructive`); shots.push({ base: `${stepBase}-before-destructive`, caption: `Step ${i + 1}: stopped before destructive action` });
      actions.push({ step: i, did: `${tag}STOP before destructive: "${action.label || "run SQL"}" (not on a fork)`, status: "stopped" });
      haltedBeforeDestructive = true;
      return true;
    }
    // Snapshot rows before a click that creates something, so the new row can be identified after.
    const rowsBefore = action.action === "click" && /\bcreate\b/i.test(action.label || "") ? await rowTexts(page) : null;
    try {
      if (action.action === "select_service") {
        await gotoServiceById(page, serviceId);
        await settle(page); // ensure tabs and nav are fully interactive
        serviceSelected = true; // so a mid-walk re-login comes back HERE and not to the project
        actions.push({ step: i, did: `${tag}select service`, status: "ok" });
      } else if (action.action === "goto") {
        // Positioning by URL. Deliberately dumb: no label matching, no waiting on a control to
        // appear, so it cannot fail for the reasons a documented click can. A fresh load also
        // collapses panels a previous step left open, which is most of why a plan reaches for it.
        const target = `https://console.cloud.tigerdata.com/projects/${PROJECT_ID}/services/${serviceId}${action.path}`;
        await page.goto(target, { waitUntil: "load", timeout: 60000 });
        await settle(page);
        actions.push({ step: i, did: `${tag}went to \`${action.path}\``, status: "ok" });
      } else if (action.action === "open_url") {
        // A site the page names, outside the Console. Positioning like `go to`, with the URL taken
        // from the plan, which quotes the page. A later Console step needs `select the service` to
        // come back, the same way any plan repositions.
        await page.goto(action.url, { waitUntil: "load", timeout: 60000 });
        await page.waitForTimeout(1500);
        actions.push({ step: i, did: `${tag}opened \`${action.url}\``, status: "ok" });
      } else if (action.action === "expect_url") {
        // Asserts where a DOCUMENTED click chain landed, so "the label was clickable" is not
        // mistaken for "the documented path works".
        const here = page.url();
        const ok = here.includes(action.fragment);
        actions.push({
          step: i,
          did: ok
            ? `${tag}url contains \`${action.fragment}\``
            : `${tag}expected the url to contain \`${action.fragment}\`, but it is \`${here.replace(/https:\/\/[^/]+/, "")}\``,
          status: ok ? "ok" : "fail",
        });
      } else if (action.action === "replace_statement") {
        // Click into the editor, select all, replace. Capped and verified, because both failure modes
        // here are silent: insertText has stalled until the step ceiling abandoned it, and the editor
        // has been found `aria-hidden` with a zero-size box, where a click times out. If the statement
        // does not land the wizard runs its OWN generated statement, which would otherwise report a
        // pass — the thing this step exists to catch.
        //
        // Monaco's API is not available: the Console bundles it as a module, so there is no
        // window.monaco to call setValue on.
        //
        // The panel mounts slowly and nothing used to wait for it, which is why this step behaved
        // differently on each attempt (31 ms once, not present after four seconds another time). It is
        // not persisted wizard state: there is no wizard-progress key in localStorage or
        // sessionStorage, though the drawer's `Reset progress` means it is tracked somewhere else.
        // So: wait for visible, scroll into view, and say so when it never appears.
        const root = (await openModal(page)) || page;
        const lines = root.locator(".monaco-editor .view-lines").first();
        // Scoped to the editor inside the wizard: `document.querySelector` takes the FIRST Monaco on
        // the page, which is the Console's own SQL Editor panel, and once reported this statement
        // missing while quoting an assertion run seven steps earlier.
        const same = (a, b) => String(a).replace(/\s+/g, " ").trim() === String(b).replace(/\s+/g, " ").trim();
        // Collapsed to one line, like the Console's own SQL Editor path. Multi-line was tried on the
        // theory that the wizard parses the statement line-wise to build its refresh-policy step: it
        // is NOT the cause (the aggregate came out with the page's columns either way, and the wizard
        // crashed either way), and it breaks verification. Monaco's `.view-lines` are
        // absolutely-positioned divs whose DOM order does not match visual order, so innerText over a
        // multi-line document returns the lines scrambled — the read-back came back with the GROUP BY
        // before the CREATE. One line has no order to get wrong.
        let wanted;
        try {
          wanted = prepareSqlForInsert(action.sql);
        } catch (e) {
          actions.push({ step: i, did: `${tag}${e.message}`, status: "fail" });
          return false;
        }

        const ready = await lines
          .waitFor({ state: "visible", timeout: 20000 })
          .then(() => true)
          .catch(() => false);
        if (!(await lines.count())) {
          actions.push({ step: i, did: "no code editor on this screen to replace the statement in", status: "fail" });
        } else if (!ready) {
          actions.push({
            step: i,
            did: "the code editor is on the page but never became visible (the panel had not finished mounting)",
            status: "fail",
          });
        } else {
          // Never retry the write by typing on a bad read: `keyboard.type` sends one CDP key event per
          // character, 302 of them wedged the renderer, and the run then spent ten minutes in
          // teardown behind a dead page. A read that is known to be unreliable cannot justify it.
          let typed = true;
          let landed = "";
          try {
            landed = await capped(`step ${i + 1} replace`, writeIntoEditor(page, lines, wanted), 40000);
          } catch (e) {
            typed = e.message;
          }

          // Three outcomes, and the middle one matters. A read that MATCHES is a pass. A read that
          // comes back with DIFFERENT text is a real failure: something mangled the statement, and
          // the text is there to see. A read that comes back EMPTY proves nothing — the editor may
          // simply not have painted — so it is reported as unverified, not as a failure, and the
          // catalog assertions at the end of the plan decide what was actually created.
          if (typed !== true) {
            actions.push({ step: i, did: `could not replace the statement: ${typed}`, status: "fail" });
          } else if (same(landed, wanted)) {
            actions.push({ step: i, did: `replaced the editor's statement with the one the page gives (${wanted.length} chars)`, status: "ok" });
          } else if (landed.trim()) {
            actions.push({
              step: i,
              did: `the editor holds something other than the page's statement — "${landed.slice(0, 80)}…" — so the wizard would run that`,
              status: "fail",
            });
          } else {
            actions.push({
              step: i,
              did: "wrote the statement but could not read the editor back to confirm it (Monaco renders only painted lines) — the aggregate assertions at the end of this plan are what verify it",
              status: "blocked",
            });
          }
        }
      } else if (action.action === "confirm") {
        // A confirm is the one press a page need not document, so it is also the one press with no
        // prose to check it against. What CAN be checked is the claim the verb makes: that a dialog
        // is open. If the step that should have opened one failed, this fails here rather than
        // hunting the label across the whole page and pressing something else that happens to match.
        const dlg = await openModal(page);
        if (!dlg) {
          actions.push({ step: i, did: `${tag}no dialog open to confirm \`${action.label}\`  — the step before it did not open one`, status: "fail" });
          return false;
        }
        // Scoped to the dialog, never page-wide: a dialog's `Remove` and the row's own `Remove`
        // behind it are different controls with the same label.
        if (DOWNLOAD_LABEL.test(action.label || "")) {
          // The confirm that actually starts a download (`Download logs` > `Download`). Asserted
          // the way a plain download click is: the file must arrive, and must not be empty.
          const [download] = await Promise.all([
            page.waitForEvent("download", { timeout: 45000 }).catch(() => null),
            clickLabel(page, action.label, { within: dlg }),
          ]);
          if (!download) {
            actions.push({ step: i, did: `${tag}confirmed \`${action.label}\` but no download started within 45s`, status: "fail" });
            return false;
          }
          const name = download.suggestedFilename();
          const file = await download.path().catch(() => null);
          const bytes = file ? statSync(file).size : 0;
          const artifact = file ? saveRedactedDownload(prefix, i, name, file) : null;
          actions.push({
            step: i,
            did: bytes > 0
              ? `${tag}confirmed \`${action.label}\` and downloaded \`${name}\` (${bytes} bytes)`
              : `${tag}confirmed \`${action.label}\`, a download started, but \`${name}\` arrived empty`,
            status: bytes > 0 ? "ok" : "fail",
            artifact: artifact || undefined,
          });
          return false;
        }
        await clickLabel(page, action.label, { within: dlg });
        await page.waitForLoadState("networkidle", { timeout: 15000 }).catch(() => {});
        await page.waitForTimeout(action.destructive ? 5000 : 1500);
        actions.push({ step: i, did: `${tag}confirmed \`${action.label}\``, status: "ok" });
      } else if (action.action === "expect_label") {
        // Text on the page, asserted. Deliberately not restricted to interactive elements: what this
        // proves is usually a STATE the app renders as text (`Meeting policy`, an invited address in
        // a table), not a control. The value may come from the environment so a plan can assert on
        // the address it invited without publishing one.
        const want = action.name ? testInputValue(action.name) : action.label;
        if (!want) {
          actions.push({ step: i, did: `needs test input \`${action.name}\` to assert on — set ${testInputEnvVar(action.name)}`, status: "blocked" });
        } else {
          // PRESENCE is asserted inside whatever is open on top when something is: its contents are
          // what is actionable, and these assertions usually follow a click that opened it.
          //
          // openOverlay, not openModal, because a row's `⋮` is a menu rather than a dialog. Scoped to
          // dialogs only, an assertion about a menu item fell through to a page-wide getByText and so
          // passed on the text being anywhere in the Console — including when the menu never opened
          // at all. That is the assertion a plan uses to check a control it deliberately does not
          // press, so it is exactly the one that must not pass for the wrong reason.
          //
          // ABSENCE is asserted PAGE-WIDE, always. Scoping "X is gone" to a dialog asks the wrong
          // question — the value is not in the dialog whether or not it is still on the page behind
          // it, so the assertion passes for the wrong reason. Observed: a members run whose removal
          // steps had all failed left the invite standing with a modal over it, and
          // `expect no label` reported "is gone from the page". That assertion is the only evidence
          // a plan with no SQL has, so it is exactly the one that must not be scoped away.
          //
          // POLLED, not checked once. The state a plan asserts is often the far end of a transition
          // the Console animates through — `Pause service` shows `Pausing` for a while before
          // `Paused`, a resumed service is `Resuming` before it is `Ready` — and a single check right
          // after the click sees the intermediate state and reports the documented outcome as a
          // failure. The window is long enough for a pause or resume to finish; a label that is
          // simply wrong costs the whole window, which is the price of asserting state at all. The
          // report says how long it waited when that was more than a moment, so a slow pass is
          // visible as slow rather than read as instant.
          const deadline = Date.now() + EXPECT_LABEL_WINDOW_MS;
          const started = Date.now();
          let ok = false;
          for (;;) {
            const root = action.absent ? page : (await openOverlay(page))?.node || page;
            const found = root.getByText(want, { exact: false }).filter({ visible: true });
            const present = (await found.count()) > 0;
            ok = action.absent ? !present : present;
            if (ok || Date.now() >= deadline) break;
            await page.waitForTimeout(2000);
          }
          const waited = Math.round((Date.now() - started) / 1000);
          const after = waited >= 5 ? ` (after ${waited}s)` : "";
          actions.push({
            step: i,
            did: ok
              ? action.absent
                ? `\`${want}\` is gone from the page${after}`
                : `\`${want}\` is on the page${after}`
              : action.absent
              ? `expected \`${want}\` to be gone, and it is still there${after}`
              : `expected \`${want}\` on the page, and it is not there${after}`,
            status: ok ? "ok" : "fail",
          });
        }
      } else if (action.action === "expect_enabled") {
        const state = await labelEnabledState(page, action.label);
        actions.push({
          step: i,
          did:
            state === "enabled"
              ? `\`${action.label}\` is there and usable`
              : state === "disabled"
              ? `\`${action.label}\` is there but greyed out`
              : `expected \`${action.label}\`, and no such control is on the page`,
          status: state === "enabled" ? "ok" : "fail",
        });
      } else if (action.action === "dismiss") {
        // Mirrors `confirm`: the verb claims something is open, so nothing open is a failure of the
        // step that should have opened it, reported here rather than three meaningless steps later.
        const overlay = await openOverlay(page);
        if (!overlay) {
          actions.push({ step: i, did: `${tag}nothing was open to dismiss — the step before it did not open a menu or dialog`, status: "fail" });
          return false;
        }
        await page.keyboard.press("Escape").catch(() => {});
        await page.waitForTimeout(500);
        let still = await openOverlay(page);
        // Escape stops closing a dialog once focus sits inside one of its dropdowns: the Connection
        // info dialog ignored it after its `Role` select had been changed (confirmed live
        // 2026-09-25). A reader would press the dialog's X, so fall back to its close button.
        let via = "";
        if (still && still.kind === "dialog") {
          // A dialog can hold more than one X (this one also closes its own warning banner), so try
          // each until the dialog itself is gone rather than trusting the first match.
          const xs = still.node.getByRole("button", { name: /^close$/i }).filter({ visible: true });
          const n = Math.min(await xs.count().catch(() => 0), 3);
          for (let k = 0; k < n && still; k++) {
            await xs.nth(0).click({ timeout: 5000 }).catch(() => {});
            await page.waitForTimeout(500);
            still = await openOverlay(page);
          }
          if (n) via = " with its close button (Escape did not close it)";
        }
        actions.push({
          step: i,
          did: still ? `${tag}pressed Escape and the ${overlay.kind} is still open` : `${tag}closed the ${overlay.kind}${via}`,
          status: still ? "fail" : "ok",
        });
      } else if (action.action === "choose_option") {
        // The docs left this choice open on purpose. Pick whichever radio option is not already
        // selected — a DOM rule, never a judgement about which option is best.
        const picked = await resolveOpenChoice(page);
        actions.push({
          step: i,
          did: picked
            ? `${tag}picked an option the docs leave open`
            : `${tag}found no unselected option to pick — the submit control will stay disabled`,
          status: picked ? "ok" : "fail",
        });
      } else if (action.action === "select_replica") {
        await selectReplicaRow(page);
        actions.push({ step: i, did: `${tag}select replica set`, status: "ok" });
      } else if (action.action === "open_row") {
        // The first row that drills one level below the current path. Fails loudly when the list is
        // empty or its rows are not links: a plan that "opened a row" on a page with nothing to open
        // must not read as a pass.
        const item = await resolveListItemTarget(page);
        if (!item) {
          actions.push({ step: i, did: `${tag}no row to open: nothing on this page links one level below \`${new URL(page.url()).pathname}\``, status: "fail" });
          return false;
        }
        await item.locator.click({ timeout: 10000 });
        await page.waitForLoadState("networkidle", { timeout: 15000 }).catch(() => {});
        await settle(page);
        actions.push({ step: i, did: `${tag}opened the first row, \`${item.label}\` (docs leave the choice open)`, status: "ok" });
      } else if (action.action === "edit_parameter_value") {
        const ed = await editParameterValue(page, action.param || null);
        // The grid marks a bad value "Out of range" on the row itself; check it rather than claim it.
        actions.push(
          ed.missing
            ? { step: i, did: `${tag}no numeric parameter \`${ed.name}\` in the grid`, status: "fail" }
            : ed.outOfRange
            ? { step: i, did: `${tag}set \`${ed.name}\` to ${ed.next}, which the grid marks Out of range`, status: "fail" }
            : { step: i, did: `${tag}set \`${ed.name}\` from ${ed.current} to ${ed.next}${action.param ? "" : " (docs left the choice open)"}`, status: "ok" }
        );
      } else if (action.action === "create_service") {
        await goToNewServiceWizard(page);
        actions.push({ step: i, did: `${tag}open the new-service wizard`, status: "ok" });
      } else if (action.action === "click" && DOWNLOAD_LABEL.test(action.label || "")) {
        // Wait for the DOWNLOAD EVENT, not for the network to settle. A download doesn't quiet the
        // network the way a navigation does, which is why this step looked unautomatable and got
        // annotated manual once — that run recorded the stall next to a 10-minute wait
        // for a service still showing Queued/Provisioning, which is the likelier culprit. Playwright
        // accepts downloads by default (since 1.16; this is 1.61) and writes them to a temp dir.
        const [download] = await Promise.all([
          page.waitForEvent("download", { timeout: 45000 }).catch(() => null),
          rowScope && !rowUsed ? clickLabel(page, action.label, { within: rowScope }) : clickLabel(page, action.label),
        ]);
        if (!download) {
          // A download button that opens a dialog first (`Download logs` asks how many rows) has
          // done its job when the dialog is up; the file arrives on the dialog's confirm, and the
          // `confirm` verb waits for it. Reporting this as "no download" left the dialog covering
          // the page and failed the next fourteen steps for one cause.
          const dlg = await openModal(page);
          if (dlg) {
            actions.push({ step: i, did: `${tag}clicked \`${action.label}\`; it opened a dialog, so the download is behind its confirm`, status: "ok" });
            return false;
          }
          actions.push({ step: i, did: `${tag}clicked \`${action.label}\` but no download started within 45s`, status: "fail" });
          return false;
        }
        const name = download.suggestedFilename();
        const file = await download.path().catch(() => null);
        const bytes = file ? statSync(file).size : 0;
        // Keep an auditable artifact, but NEVER the secrets. This file is the reader's credentials —
        // the Console says it is the only time they can get the password — so the raw copy must not
        // linger on disk. Playwright's temp copy dies with the context; what survives here is a
        // REDACTED transcript plus a sha256 of the original, which is enough to audit the step from
        // the report (the file arrived, it has the fields a reader needs) and useless if leaked.
        const artifact = file ? saveRedactedDownload(prefix, i, name, file) : null;
        const fields = artifact?.fields?.length ? `; fields: ${artifact.fields.join(", ")}` : "";
        // Assert the ARTIFACT, not just the click: a zero-byte file is what a reader would experience
        // as a broken download, and reporting the click alone would hide it.
        actions.push({
          step: i,
          did:
            bytes > 0
              ? `${tag}clicked \`${action.label}\` and downloaded \`${name}\` (${bytes} bytes, sha256 ${artifact?.sha256.slice(0, 12) || "?"})${fields}`
              : `${tag}clicked \`${action.label}\`, a download started, but \`${name}\` arrived empty`,
          status: bytes > 0 ? "ok" : "fail",
          artifact: artifact || undefined,
        });
        return false;
      } else if (action.action === "click" && action.after) {
        // One option out of a group of identically-labelled ones. Scoped by DOCUMENT ORDER: the first
        // matching option that appears after the group's own label. That is exact for a stack of
        // groups — the first `24 hours` after `End offset` belongs to End offset, because Schedule
        // interval's copy comes later — and it needs no assumption about the DOM's nesting, which a
        // "nearest common ancestor" rule would.
        const target = page
          .locator(
            `xpath=//*[normalize-space(text())=${JSON.stringify(action.after)}]` +
            `/following::*[normalize-space(text())=${JSON.stringify(action.label)}][1]`
          )
          .filter({ visible: true })
          .first();
        if (!(await target.count().catch(() => 0))) {
          actions.push({ step: i, did: `${tag}no \`${action.label}\` after \`${action.after}\``, status: "fail" });
          return false;
        }
        await target.click({ timeout: 10000 }).catch(async () => {
          await target.locator("xpath=ancestor::label[1]").first().click({ timeout: 10000 });
        });
        await page.waitForTimeout(800);
        actions.push({ step: i, did: `${tag}clicked \`${action.label}\` in \`${action.after}\``, status: "ok" });
      } else if (action.action === "click") {
        // Whether THIS click was scoped to a pinned row, for the note below. Not rowPinned, which
        // stays true for the rest of the procedure once any step has pinned.
        let scopedToRow = false;
        if (isServiceCreation(action)) {
          // Text-based clickLabel is unreliable here: "Create service" is only the label on the
          // wizard's final step, and a generic text search could hit an unrelated element earlier
          // in the DOM. The wizard's own submit button has a stable, purpose-built data-cy.
          let submit = page.locator('[data-cy="create-service-button"]').filter({ visible: true }).first();
          if (!(await submit.count())) {
            // Confirmed live: the wizard can silently drop back a step during the
            // dwell time between "open the wizard" and this click (e.g. this walker's own
            // settle()-before-screenshot wait occasionally runs its full ~25s "wait for loading
            // text to clear" timeout) — re-drive it once (idempotent: a no-op if already on the
            // final step) instead of going straight to a generic text search that has nothing
            // reliable to match once the submit button isn't there.
            await goToNewServiceWizard(page);
            submit = page.locator('[data-cy="create-service-button"]').filter({ visible: true }).first();
          }
          // Name it before creating it (see namedCreated). The field is on the same pane as the
          // button; when it is not there, or the value does not stick, the wizard has changed shape,
          // and the walk refuses the click rather than create a service it could not tell apart from
          // others and would then never delete. Blocked, not failed: the documented click was never
          // tried, and it is the tool that needs a look.
          namedCreated = nameCreated ? nameCreated() : null;
          if (namedCreated) {
            const nameField = page.locator('[data-cy="service-name-input"]').filter({ visible: true }).first();
            if (await nameField.count()) {
              await nameField.fill(namedCreated, { timeout: 10000 });
              await page.waitForTimeout(300);
              if ((await nameField.inputValue().catch(() => "")) !== namedCreated) namedCreated = null;
            } else namedCreated = null;
            if (!namedCreated) {
              actions.push({ step: i, did: `${tag}could not set the service name on the wizard's final pane, so \`${action.label}\` was not clicked: a service the tool cannot name is one it cannot clean up`, status: "blocked" });
              return false;
            }
          }
          if (await submit.count()) await submit.click({ timeout: 10000 });
          else await clickLabel(page, action.label); // fallback if the data-cy attribute ever changes
        } else if (!rowScope && !rowUsed && MENU_GLYPH.test(action.label) && createdRowText) {
          scopedToRow = true;
          // No explicit testRow, but this procedure created a row a moment ago — that's the one the
          // docs mean. Scoped to it, never to whatever row happens to be first.
          const created = page.locator('[role="row"], tr').filter({ visible: true }).filter({ hasText: createdRowText.slice(0, 40) }).first();
          const trigger = created
            .locator('[data-cy="contextual-menu-button-open"], [data-cy*="context-menu"], [aria-haspopup="menu"]')
            .filter({ visible: true });
          if (!(await trigger.count())) throw new Error("no context menu on the row this procedure created");
          await trigger.first().click({ timeout: 10000 });
          rowUsed = true;
        } else if (rowScope && !rowUsed) {
          scopedToRow = true;
          // The row-identifying click. It must land INSIDE the pinned row or not at all: falling
          // back to a page-wide search here would defeat the entire point of pinning, and the very
          // next click in these procedures is usually the destructive one.
          //
          // `⋮` is a glyph the docs write but the DOM never contains — the trigger is an SVG button
          // with no accessible name, identified by data-cy (confirmed live). Anything else is
          // matched normally, just scoped.
          if (MENU_GLYPH.test(action.label)) {
            const trigger = rowScope
              .locator('[data-cy="contextual-menu-button-open"], [data-cy*="context-menu"], [aria-haspopup="menu"]')
              .filter({ visible: true });
            if (!(await trigger.count())) throw new Error(`no contextual menu control in the pinned row for \`${action.label}\``);
            await trigger.first().click({ timeout: 10000 });
          } else {
            await clickLabel(page, action.label, { within: rowScope });
          }
          // Only NOW is the scope spent. Marking it used on an attempt let a failed row click hand
          // the next (destructive) click a page-wide search.
          rowUsed = true;
        } else {
          await clickLabel(page, action.label, { role: action.role || null });
        }
        await page.waitForLoadState("networkidle", { timeout: 15000 }).catch(() => {});
        // For a destructive click, wait longer so the end-of-step screenshot captures the settled
        // result (no separate shot here — it would duplicate the end-of-step one).
        await page.waitForTimeout(action.destructive || isServiceCreation(action) ? 5000 : 1500);
        // The click landed, but did the FORM accept it? A submit that trips validation leaves the
        // dialog open with nothing created, and reported as a plain success it turns the rest of the
        // procedure into nonsense (the next step looks for a resource that was never made).
        //
        // Deliberately does NOT try to guess the missing value. A field the docs leave open is
        // supplied by a testInput annotation, where the name lives in the docs and the value in the
        // environment; inventing one here would be a second, competing mechanism that decides content
        // on the author's behalf. No testInput and a rejected form is a real, reportable gap.
        const rejected = await formValidationError(page);
        if (rejected) {
          await shot(page, `${stepBase}-rejected`);
          shots.push({ base: `${stepBase}-rejected`, caption: `Step ${i + 1}: the form rejected the submission` });
          actions.push({
            step: i,
            did: `${tag}clicked \`${action.label}\` but the form rejected it — ${rejected}. If the docs leave this value open, annotate the step with testInput`,
            status: "blocked",
          });
          return false; // step recorded as blocked; the walk continues (runAction returns true only to HALT)
        }
        // Did this click add a row? If so it's the object this procedure created, and later steps
        // that say "the ⋮ menu" mean THAT row. Requires exactly one new row: more than one and we
        // can't tell which is ours, so we keep no pin rather than guess.
        if (rowsBefore) {
          const after = await rowTexts(page);
          const fresh = after.filter((t) => !rowsBefore.includes(t));
          if (fresh.length === 1) createdRowText = fresh[0];
        }
        if (action.destructive || isServiceCreation(action)) sawDestructiveCreate = true;
        if (isServiceCreation(action)) {
          // Find the service that was just created: the one that appeared since the snapshot AND
          // carries the name typed above (lib/fork.mjs partitionArrivals, the sweep's rule too). An
          // arrival with another name is reported and left alone; it is not this walk's, whatever the
          // timing says. Without a name to type (no nameCreated given) the diff is all there is.
          const { listServices, waitUntilReady, partitionArrivals } = await import("./fork.mjs");
          const listed = await listServices().catch(() => []);
          const { mine, others } = namedCreated
            ? partitionArrivals(servicesBefore, listed, [namedCreated])
            : { mine: listed.filter((s) => (s.service_id || s.id) && !servicesBefore.has(s.service_id || s.id)), others: [] };
          for (const s of others) actions.push({ step: i, did: `${tag}service ${s.service_id || s.id} (${s.name || "unnamed"}) appeared in the project during this step and is not this run's; left alone`, status: "ok" });
          // Captured: a later creation in this walk must not see this one as new again.
          for (const s of mine) servicesBefore.add(s.service_id || s.id);
          const newServices = mine.map((s) => s.service_id || s.id);
          if (newServices.length > 0) {
            createdServiceId = newServices[0];
            // Retarget THIS procedure at the service it just made. The page's remaining steps say
            // "connect to your service" and mean THAT one, so without this they resolve against the
            // standing service: the documented psql connect skipped for want of credentials the tool
            // will not rotate on a standing service, and the Console SQL that followed ran somewhere
            // the page never mentioned and reported a pass for it.
            //
            // scripts/test-page.mjs already adopts a created service BETWEEN procedures. That never
            // helps a page documenting create-then-connect as one procedure, which is how every
            // quickstart writes it.
            //
            // Retarget immediately. Creating the service SUCCEEDED the moment it exists: QUEUED and
            // CONFIGURING are successful outcomes, and a plan that creates a service and stops has
            // nothing to wait for. Readiness is a precondition of USING it, not evidence that the
            // documented click worked, so the wait is deferred to the first step that needs a live
            // database (see awaitTargetUsable). Both connection caches belong to the old target.
            serviceId = createdServiceId;
            serviceOwned = true; // a throwaway this run made, so its password may be rotated to get in
            connCache = undefined;
            endpointCache = undefined;
            retargeted = createdServiceId;
            awaitTargetUsable = async () => {
              awaitTargetUsable = null; // once per retarget
              const ready = await waitUntilReady(createdServiceId).catch(() => ({ ok: false }));
              if (!ready.ok) {
                // Not fatal here: the step that asked for a live database reports its own failure,
                // with the real error. This only records WHY, so the report does not read as a
                // documentation bug when the cause was a database still provisioning.
                actions.push({ step: i, did: `${tag}service ${createdServiceId} is still ${ready.status || "not READY"}; the step below needed a live database`, status: "blocked" });
              }
            };
          }
        }
        // Say WHERE a destructive click was allowed to run. "ran on fork" would be false for a
        // row-pinned project-level action: there is no fork, the safety came from the pinned row,
        // and the change landed on the real project.
        // Say WHERE this click ran, and say it about THIS click. `rowPinned` is sticky across steps
        // on purpose (a confirm dialog belongs to the row pinned earlier), so reading it here
        // labelled page-wide clicks "ran on the pinned row" — the note that made a run whose row
        // clicks resolved nothing look deliberate and safe. `scopedToRow` is the actual scope used.
        //
        // Service creation is checked FIRST because it is also destructive, so the destructive arm
        // used to win and the note read " (ran page-wide, on the real project)" — true, but it buries
        // the one fact a reader of this report needs, which is that a service now exists.
        const why = isServiceCreation(action)
          ? retargeted
            ? ` (created service ${retargeted}${namedCreated ? `, named \`${namedCreated}\` by the tool` : ""}; the steps below run on it)`
            : " (clicked, but no new service appeared)"
          : action.destructive
            ? allowDestructive
              ? " (ran on fork)"
              : scopedToRow
                ? " (ran on the pinned row, on the real project)"
                : " (ran page-wide, on the real project)"
            : "";
        actions.push({ step: i, did: `${tag}click \`${action.label}\`${why}`, status: "ok" });
      } else if (action.action === "select_other_option") {
        // Scoped to the pinned row when there is one — a members list has one role dropdown per
        // row, and an unpinned change would land on whoever is listed first.
        //
        // Unpinned falls back to the whole page, NOT page.locator("main"): this Console renders no
        // <main> at all, so that locator matched nothing and every unpinned dropdown step reported
        // "no dropdown found" for a control sitting in plain view. The chrome holds no select or
        // react-select (its only control is the Ops/Data radio pair), so page-wide is safe here.
        //
        // A NAMED drop-down ("in `Severity type`") is resolved by its caption or shown value instead,
        // and is not restored at the end: the ones a page names by caption are filters, whose state
        // lives in the page and not in the account, so there is nothing to put back. The members role
        // selector, the one change that does commit, is reached through the unnamed form.
        let scope = rowScope || page;
        if (action.field) {
          scope = await dropdownNamed(page, action.field);
          if (!scope) {
            actions.push({ step: i, did: `${tag}no drop-down called \`${action.field}\` — no caption or shown value matches it`, status: "fail" });
            return false;
          }
        }
        const pickKey = `${new URL(page.url()).pathname}|${action.field || ""}|${pinValue || ""}`;
        const r = await selectOtherOption(page, scope, { avoid: pickedOptions.get(pickKey) || [] });
        if (r.chosen) pickedOptions.set(pickKey, [...(pickedOptions.get(pickKey) || []), r.chosen]);
        const which = action.field ? `\`${action.field}\`` : "the dropdown";
        if (r.chosen) {
          // The docs say this commits immediately, so remember the original to put back at the end.
          // The URL too: a later step can navigate away, and the restore runs at the END of the walk.
          if (!action.field) dropdownRestores.push({ pinValue, original: r.before, url: page.url() });
          // An option's text can carry a count the chosen value does not (`Fatal0` in the option
          // list, `Fatal` once shown), so the option text is only the prefix of what the control then
          // reads. The change is real when the control shows something new that the option began with.
          const took = r.after === r.chosen || (!!r.after && r.after !== r.before && r.chosen.startsWith(r.after));
          actions.push({ step: i, did: `${tag}changed ${which} from \`${r.before}\` to \`${r.after ?? r.chosen}\``, status: took ? "ok" : "fail" });
        } else {
          actions.push({ step: i, did: `${tag}couldn't change ${which} — ${r.error}`, status: "fail" });
        }
      } else if (action.action === "click_one_of") {
        // "Select `MFA` or `SSO`": any one satisfies the docs, but availability depends on the
        // account — MFA is disabled on this project while SSO is offered. Pick the first ENABLED
        // alternative and say which, rather than failing on a correct instruction because the
        // first-listed option happens to be gated.
        const tried = [];
        let done = null;
        for (const label of action.labels) {
          const opt = page
            .getByRole("radio", { name: label, exact: false })
            .or(page.getByRole("button", { name: label, exact: true }))
            .or(page.getByRole("checkbox", { name: label, exact: false }))
            .filter({ visible: true });
          if (!(await opt.count())) { tried.push(`${label}: not found`); continue; }
          const el = opt.first();
          if (!(await el.isEnabled().catch(() => false))) { tried.push(`${label}: disabled`); continue; }
          const lab = el.locator("xpath=ancestor::label[1]");
          await ((await lab.count()) ? lab.first() : el).click({ timeout: 10000 });
          await page.waitForTimeout(1500);
          done = label;
          break;
        }
        if (done) {
          const skipped = tried.length ? ` (${tried.join("; ")})` : "";
          actions.push({ step: i, did: `${tag}selected \`${done}\`${skipped}`, status: "ok" });
        } else {
          actions.push({ step: i, did: `${tag}none of ${action.labels.map((l) => `\`${l}\``).join(" / ")} was available — ${tried.join("; ")}`, status: "fail" });
        }
      } else if (action.action === "toggle") {
        // Find the switch the docs named. Preference order: a switch whose own accessible name
        // matches, then the switch nearest that label's text, then the page's only switch. Clicking
        // the label TEXT is not reliable — the control is a separate element beside it.
        // A row qualifier wins outright. The CSV upload's column mapping carries one
        // `Hypertable partition` switch per column, none of them with an accessible name, so every
        // strategy below would either miss or pick an arbitrary row — and picking the wrong column to
        // partition on is a silent wrong answer, not a visible failure.
        let target = null;
        if (action.row) {
          const row = page
            .locator('[role="row"], tr')
            .filter({ visible: true })
            .filter({ hasText: action.row });
          if (await row.count()) {
            const sw = row.first().locator('[role="switch"], input[type="checkbox"]').filter({ visible: true });
            if (await sw.count()) target = sw.first();
          }
          if (!target) {
            actions.push({ step: i, did: `${tag}no row for \`${action.row}\` with a \`${action.label}\` control`, status: "fail" });
            return false;
          }
        }
        const byName = page.getByRole("switch", { name: action.label, exact: false }).filter({ visible: true });
        if (!target) target = (await byName.count()) ? byName.first() : null;
        if (!target) target = await switchNearLabel(page, action.label);
        if (!target) {
          // "Toggle" in the docs doesn't always mean a switch. `Data view` at the top right is a mode
          // SWITCHER: a <p> inside role=menuitem inside role=menu[data-cy=mode-switcher], and the page
          // carries no chakra switch at all — so the switch hunt above could never succeed and the step
          // failed on a control that is right there and perfectly clickable. Any two-state control the
          // docs call a toggle is satisfied by clicking the named side of it.
          try {
            await clickLabel(page, action.label);
            await page.waitForLoadState("networkidle", { timeout: 15000 }).catch(() => {});
            await page.waitForTimeout(1500);
            actions.push({ step: i, did: `${tag}clicked \`${action.label}\` (a two-state control, not a switch)`, status: "ok" });
            return false;
          } catch (e) {
            actions.push({ step: i, did: `${tag}couldn't find a \`${action.label}\` switch or control — ${(e.message || "").split("\n")[0]}`, status: "fail" });
            return false;
          }
        } else {
          const before = await switchChecked(target);
          const want = action.desired === undefined ? !before : action.desired;
          if (before !== want) {
            // A Chakra switch is a 1x1px input inside a label, with the visible track drawn by the
            // label's children. Playwright counts that input as visible but clicking it times out,
            // so click the enclosing label — the actual control surface — and keep reading state
            // from the input.
            const label = target.locator("xpath=ancestor::label[1]");
            const clickTarget = (await label.count()) ? label.first() : target;
            await clickTarget.click({ timeout: 10000 });
            await page.waitForLoadState("networkidle", { timeout: 15000 }).catch(() => {});
            await page.waitForTimeout(2000);
          }
          const after = await switchChecked(target);
          // A switch that hasn't moved isn't necessarily broken: it may be gated behind a
          // confirmation the docs cover in a LATER step (Enhanced authentication opens an "Enable
          // enhanced authentication" dialog and only commits once Enable is clicked). Treating that
          // as a failure blames the docs for correctly describing a two-stage flow.
          const pending = after !== want && (await page.locator('[role="dialog"]').filter({ visible: true }).count()) > 0;
          actions.push({
            step: i,
            did: after === want
              ? `${tag}turned \`${action.label}\` ${want ? "on" : "off"}`
              : pending
              ? `${tag}\`${action.label}\` opened a confirmation dialog; not committed yet`
              : `${tag}\`${action.label}\` did not change to ${want ? "on" : "off"}`,
            status: after === want || pending ? "ok" : "fail",
          });
        }
      } else if (action.action === "type_dialog_value") {
        // The dialog says what it wants ('Type "686" to confirm'); read that, type it into the
        // dialog's one field. Every branch that cannot do exactly that FAILS: no dialog, a dialog that
        // does not say, more than one field. A guess here would confirm a destructive action with the
        // wrong value and report the keystrokes as a pass.
        const dlg = await openModal(page);
        if (!dlg) {
          actions.push({ step: i, did: `${tag}no dialog open to read a value from — the step before it did not open one`, status: "fail" });
          return false;
        }
        const said = ((await dlg.textContent().catch(() => "")) || "").replace(/\s+/g, " ").trim();
        // No trailing word boundary: the dialog's text runs straight into its buttons ("…to
        // confirmCancelDelete"), which is what made the first version of this miss a dialog that
        // said exactly what it wanted.
        const asked = said.match(/\btype\s+["“'‘]([^"”'’]+)["”'’]\s+to\s+confirm/i);
        if (!asked) {
          actions.push({ step: i, did: `${tag}the dialog does not say what to type (no 'Type "…" to confirm'): "${said.slice(0, 160)}"`, status: "fail" });
          return false;
        }
        const fields = dlg.locator('input:not([type="hidden"]), textarea').filter({ visible: true });
        const n = await fields.count().catch(() => 0);
        if (n !== 1) {
          actions.push({ step: i, did: `${tag}expected one field in the dialog to type "${asked[1]}" into, found ${n}`, status: "fail" });
          return false;
        }
        await fields.first().click({ timeout: 10000 });
        await fields.first().fill(asked[1], { timeout: 10000 });
        await page.waitForTimeout(600); // let the dialog re-validate before reading its verdict
        const rejected = await formValidationError(page);
        if (rejected) {
          actions.push({ step: i, did: `${tag}typed "${asked[1]}" as the dialog asked, but it rejected it — ${rejected}`, status: "fail" });
          return false;
        }
        actions.push({ step: i, did: `${tag}typed "${asked[1]}", the value the dialog asked for`, status: "ok" });
      } else if (action.action === "type") {
        // A plan that names the field must land in THAT field. typeInto falls back to the SQL editor
        // when it finds no form input, which is right for a prose-derived step and wrong here: on the
        // failed upload run it typed a table name into the SQL editor and reported the step OK, a
        // false pass on a dialog that was in fact broken. Naming the field makes the step strict.
        if (action.field) {
          // Scoped to the open dialog when there is one: the CSV upload panel holds several inputs and
          // the page behind it holds more.
          const scope = (await openModal(page)) || page;
          // Strategies in order of how reliably they identify the field the docs NAMED.
          //
          // The loose-label case is not a fallback, it is the common one: the upload panel renders
          // "Table" as plain text above an input whose placeholder is `table_name`, with no `for`
          // attribute and no aria-label. So the accessible name is "table_name" while the docs — quite
          // reasonably — call it `Table`. Matching on placeholder or aria alone found nothing here, and
          // an earlier attempt at getByLabel matched something unclickable and timed out.
          const candidates = [
            scope.getByRole("textbox", { name: action.field, exact: false }),
            scope.locator(`input[placeholder="${action.field}"], textarea[placeholder="${action.field}"]`),
            scope.locator(`input[aria-label="${action.field}"], input[name="${action.field}"]`),
            // From the TEXT NODE, not from an element whose first text node matches. The Edit job
            // config drawer prints every caption (`Schedule Interval`, `Max runtime`, ...) as a bare
            // text node inside ONE container div, interleaved with the input wrappers; an element
            // match saw only the container, whose `text()` is its first caption, so every caption
            // but the first was unfindable and `Max runtime` reported "no field". A text-node match
            // also covers the old shape (a <label> or <div> holding just the caption), whose caption
            // is its own first text node.
            scope.locator(
              `xpath=.//text()[normalize-space(.)=${JSON.stringify(action.field)}]` +
              `/following::*[(self::input and not(@type="hidden")) or self::textarea][1]`
            ),
          ];
          let field = null;
          for (const c of candidates) {
            const vis = c.filter({ visible: true });
            if (await vis.count().catch(() => 0)) {
              const first = vis.first();
              if (await first.isEditable().catch(() => false)) { field = first; break; }
            }
          }
          // A dialog holding exactly one editable field IS the field the docs named, whatever its
          // markup calls it. The delete-service dialog labels its input "Type 'DELETE' to delete:"
          // with the word in bold, so the label is three text nodes and no strategy above matches;
          // the dialog contains nothing else to type into. Never applied page-wide: outside a dialog
          // "the only field" is a guess, and a guess is how a table name once landed in the SQL editor.
          if (!field && scope !== page) {
            const only = scope.locator('input:not([type="hidden"]), textarea').filter({ visible: true });
            if ((await only.count().catch(() => 0)) === 1 && (await only.first().isEditable().catch(() => false))) {
              field = only.first();
            }
          }
          if (!field) {
            actions.push({ step: i, did: `${tag}no field called \`${action.field}\` to type "${action.text}" into`, status: "fail" });
            return false;
          }
          await field.click({ timeout: 10000 });
          await field.fill(applyInputs(action.text, inputs), { timeout: 10000 });
        } else {
          await typeInto(page, applyInputs(action.text, inputs));
        }
        // Typing is only a success if the form ACCEPTED what was typed. A confirmation dialog that
        // demands an exact string rejects a near-miss and leaves its confirm button disabled, so the
        // documented action never actually happens — and reporting the keystrokes as a pass is a false
        // pass on the most important step of the procedure.
        //
        // Real case: the IP allow list attach dialog demands `APPLY`, the docs say `Apply`. The tool
        // typed "Apply", the Console answered 'You must type "APPLY" to confirm', the confirm button
        // stayed disabled, the list was never attached — and the page was reported PASS 6/6.
        await page.waitForTimeout(600); // let the dialog re-validate before reading its verdict
        const typeRejected = await formValidationError(page);
        if (typeRejected) {
          await shot(page, `${stepBase}-rejected`);
          shots.push({ base: `${stepBase}-rejected`, caption: `Step ${i + 1}: the form rejected what was typed` });
          actions.push({
            step: i,
            did: `${tag}typed "${action.text}" but the form rejected it — ${typeRejected}`,
            status: "fail",
          });
          return false;
        }
        actions.push({ step: i, did: `${tag}typed "${action.text}"${action.field ? ` into \`${action.field}\`` : ""}`, status: "ok" });
      } else if (action.action === "run_shell") {
        // A documented terminal command. The program was allowlisted at extraction time and is
        // re-checked before it runs; the gaps the docs leave on purpose (a connection string the
        // reader owns) are filled from the environment, and a gap that CANNOT be filled makes the
        // step skipped-with-reason rather than a failure blamed on the page.
        const firstLine = action.command.split("\n")[0].slice(0, 70);
        const connection = await connectionFor();
        const endpoint = await endpointFor();
        const pooler = await poolerFor();
        if (!connection && /<[^>]*>|\$\{?TARGET\}?|postgres(?:ql)?:\/\//i.test(action.command)) {
          actions.push({
            step: i,
            did: `skipped \`${firstLine}\` — no credentials for service ${serviceId}. Run: tiger db save-password ${serviceId}`,
            status: "skipped",
          });
          return false;
        }
        const resolved = resolveCommand(applyTestInputs(action.command), { connection, endpoint, pooler });
        if (resolved.skip) {
          actions.push({ step: i, did: `skipped \`${firstLine}\` — ${resolved.skip}`, status: "skipped" });
          return false;
        }
        // `psql "<url>"` with no -c/-f opens an INTERACTIVE session, which a headless run cannot
        // hold open. Verify the thing the step actually claims — that this connection opens — by
        // running the same invocation with \conninfo, and say so in the report rather than implying
        // the interactive form itself was exercised.
        //
        // psql only. The same test applied to `openssl s_client … | awk …` appended -c "\conninfo"
        // to a pipeline whose last program was awk, and every documented openssl command on the
        // strict-SSL page failed on arguments the page never wrote.
        const interactive = /^psql\b/.test(withoutEnvPrefix(resolved.command)) && !/\s-(?:c|f)\b|--command|--file/.test(resolved.command);
        const toRun = interactive ? `${resolved.command} -c "\\conninfo"` : resolved.command;
        // The run's own directory as cwd and, for everything but `tiger`, as home: psql and openssl
        // then read and write only inside the run. `tiger` keeps the real home, because that is where
        // its login session lives.
        const isTiger = /^tiger\b/.test(withoutEnvPrefix(resolved.command));
        let res = await runShellCommand(toRun, { cwd: workDir, pgPassword: await pgPasswordFor(), home: isTiger ? null : workDir });
        // A documented psql connection to an endpoint the page just created can land before the
        // endpoint takes connections: the Azure connection pooler advertised its host and port and
        // then closed the first connection on two of three runs on 2026-11-23/24, while the same
        // command a few steps later worked. Retry a refused or dropped connection, and only that,
        // for the object budget; any other psql error is reported at once.
        if (!res.ok && /^psql\b/.test(withoutEnvPrefix(resolved.command)) && NOT_READY_YET.test(res.error || "")) {
          const deadline = Date.now() + OBJECT_WAIT_MS;
          let tries = 1;
          while (!res.ok && Date.now() < deadline && NOT_READY_YET.test(res.error || "")) {
            await page.waitForTimeout(5000);
            tries++;
            res = await runShellCommand(toRun, { cwd: workDir, pgPassword: await pgPasswordFor(), home: isTiger ? null : workDir });
          }
          if (res.ok) res.out = `${res.out}\n(connected on try ${tries}: the endpoint refused or dropped the first connection)`;
        }
        // The session is what the command ACTUALLY connected to, not the service connection.
        //
        // It used to be `connection`, so a documented connect as a different role, or through the
        // pooler, was recorded as a plain tsdbadmin session on the service: the connection-pooling
        // plan connected as my_app on the pooler, and the two assertions that followed ran as
        // tsdbadmin against the service and reported current_user and statement_timeout as wrong.
        // The page was right and the run said otherwise, which is the failure this tool exists to
        // avoid. Any env prefix is kept with it, since that is what authenticates the other role.
        if (res.ok && interactive) {
          const uri = resolved.command.match(/postgres(?:ql)?:\/\/[^\s"']+/i);
          const env = resolved.command.match(/^\s*(?:[A-Za-z_][A-Za-z0-9_]*=(?:"[^"]*"|'[^']*'|\S*)\s+)+/);
          psqlSession = uri ? { uri: uri[0], env: (env ? env[0] : "").trim() } : { uri: connection, env: "" };
        }
        actions.push({
          step: i,
          did: res.ok
            ? `${tag}ran \`${scrubSecrets(firstLine)}\`${interactive ? ' (added -c "\\conninfo": the documented form is interactive)' : ""} — ${meaningfulOutput(scrubSecrets(res.out), 2).slice(0, 200) || "no output"}`
            : `${tag}ran \`${scrubSecrets(firstLine)}\` — failed`,
          status: res.ok ? "ok" : "fail",
          error: res.ok ? undefined : scrubSecrets(res.error),
        });
      } else if (action.action === "paste_file") {
        // A file an earlier command wrote into the run's directory, typed into a text box. Fails when
        // the file is not there (the command before it did not produce it) or when "the box" is
        // ambiguous: exactly one visible text area, or a named field, nothing else.
        const src = join(workDir, action.file);
        if (!existsSync(src)) {
          actions.push({ step: i, did: `${tag}\`${action.file}\` is not in the run's directory — no earlier command wrote it`, status: "fail" });
          return false;
        }
        const text = readFileSync(src, "utf8");
        let box = null;
        if (action.field) {
          const byLabel = page.getByLabel(action.field, { exact: false }).filter({ visible: true });
          const byName = page.getByRole("textbox", { name: action.field, exact: false }).filter({ visible: true });
          box = (await byLabel.count()) ? byLabel.first() : (await byName.count()) ? byName.first() : null;
        } else {
          const boxes = page.locator("textarea").filter({ visible: true });
          const n = await boxes.count();
          if (n === 1) box = boxes.first();
          else {
            actions.push({ step: i, did: `${tag}expected one text box on the page to paste into, found ${n}`, status: "fail" });
            return false;
          }
        }
        if (!box) {
          actions.push({ step: i, did: `${tag}no field called \`${action.field}\` to paste into`, status: "fail" });
          return false;
        }
        await box.fill(text, { timeout: 10000 });
        actions.push({ step: i, did: `${tag}pasted \`${action.file}\` (${text.length} characters) into ${action.field ? `\`${action.field}\`` : "the box"}`, status: "ok" });
      } else if (action.action === "save_download") {
        // What the last click produced, kept at the path the page names, INSIDE the run's directory:
        // `~` is the run's home, never the account's. Two sources, in order: a file the browser
        // downloaded since the last save, or, when the site answered inline instead, the page itself
        // if what it shows is a certificate. Anything else fails: saving the wrong thing here would
        // make the documented connection that follows fail for a reason that is not the page's.
        const rel = action.path.replace(/^~\/?/, "").replace(/^\/+/, "");
        const dest = join(workDir, rel);
        let bytes = null;
        let source = null;
        if (lastDownload) {
          const tmp = await lastDownload.path().catch(() => null);
          if (tmp) { bytes = readFileSync(tmp); source = `the download \`${lastDownload.suggestedFilename()}\``; }
          lastDownload = null;
        }
        if (!bytes) {
          const body = ((await page.locator("body").innerText().catch(() => "")) || "").trim();
          if (/-----BEGIN CERTIFICATE-----/.test(body)) { bytes = Buffer.from(`${body}\n`); source = "the certificate the site showed inline"; }
        }
        if (!bytes) {
          actions.push({ step: i, did: `${tag}nothing to save as \`${action.path}\`: no download since the last save, and the page is not showing a certificate`, status: "fail" });
          return false;
        }
        mkdirSync(dirname(dest), { recursive: true });
        writeFileSync(dest, bytes);
        const certs = (bytes.toString("utf8").match(/-----BEGIN CERTIFICATE-----/g) || []).length;
        actions.push({ step: i, did: `${tag}saved ${source} as \`${action.path}\` in the run's home (${bytes.length} bytes${certs ? `, ${certs} certificate(s)` : ""})`, status: "ok" });
      } else if (action.action === "upload") {
        // A file input, set directly. Playwright cannot really drag-and-drop, and it does not need
        // to: the control behind "click to browse, or drag and drop" is an <input type=file>, and
        // setting it is what a browse would do anyway.
        if (!fixturesDir) {
          actions.push({ step: i, did: `${tag}cannot upload \`${action.file}\` — the plan fetched no files (add a Setup "fetch <url>" line)`, status: "fail" });
        } else {
          const path = join(fixturesDir, action.file);
          if (!existsSync(path)) {
            actions.push({ step: i, did: `${tag}\`${action.file}\` is not among the fetched files`, status: "fail" });
          } else {
            const input = page.locator('input[type="file"]').last();
            try {
              await input.setInputFiles(path, { timeout: 15000 });
              // setInputFiles returns as soon as the INPUT is set — the page then has to upload and
              // parse the file, and tiger-cloud-essentials' dataset is 429 MB. Waiting a fixed 2.5s
              // meant the next step went looking for the configuration fields while the dialog was
              // still mid-upload, and every later step cascaded off that: the dialog stayed open, so
              // the nav behind it was unreachable and no table was ever created.
              //
              // So wait for the thing that only exists once parsing is done — the configuration UI —
              // and give it minutes rather than seconds, since the wait scales with the file.
              const ready = page
                .locator('input[placeholder="table_name"], [role="dialog"] button:has-text("Continue")')
                .first();
              const waitedMs = await (async () => {
                const t0 = Date.now();
                try {
                  await ready.waitFor({ state: "visible", timeout: 300_000 });
                  return Date.now() - t0;
                } catch {
                  return -1;
                }
              })();
              if (waitedMs < 0) {
                actions.push({ step: i, did: `${tag}uploaded \`${action.file}\` but the configuration fields never appeared within 5 minutes`, status: "fail" });
              } else {
                actions.push({ step: i, did: `${tag}uploaded \`${action.file}\` (${Math.round(waitedMs / 1000)}s to process)`, status: "ok" });
              }
            } catch (e) {
              actions.push({ step: i, did: `${tag}couldn't upload \`${action.file}\` — no file input on the page`, status: "fail", error: (e.message || "").split("\n")[0] });
            }
          }
        }
      } else if (action.action === "exit_psql") {
        // Hand the following SQL back to the Console editor. A session persists across steps on
        // purpose, so ending one has to be said out loud.
        const had = !!psqlSession;
        psqlSession = null;
        actions.push({
          step: i,
          did: had ? `${tag}exited psql — later SQL runs in the Console editor` : `${tag}no psql session was open`,
          status: "ok",
        });
      } else if (action.action === "run_sql" && psqlSession) {
        // This variant established a psql session, so its SQL belongs in psql — running it in the
        // Console editor instead is what made the "psql on the command line" tab pass while proving
        // only that the SQL is valid, never that the documented route works.
        const sql = applyTestInputs(applyInputs(action.sql, inputs));
        // The connection string is single-quoted for the same reason: it is a URI with a password in
        // it, and inside double quotes sh would expand a `$` or a backtick in that password.
        // Same directory and home as the `run command` that opened this session: a `verify-full`
        // session reads its root.crt from the run's home, and without this the later SQL looked in
        // the real one and failed a connection that had just succeeded one step earlier.
        // A statement the docs run through psql can be a bulk load: the essentials `\COPY` of the
        // 5.1M-row sample took over the 120 s default on 2026-11-24 and was killed with no stderr,
        // so the run read "Command failed" with nothing to explain it. The step ceiling is the budget.
        const res = await runShellCommand(`${psqlSession.env ? psqlSession.env + " " : ""}psql ${shq(psqlSession.uri)} -v ON_ERROR_STOP=1 -c ${shq(sql)}`, { cwd: workDir, pgPassword: await pgPasswordFor(), home: workDir, timeoutMs: STEP_CEILING_MS });
        actions.push({
          step: i,
          did: res.ok
            ? `${tag}${action.assertion ? "assertion held through psql" : `ran SQL through psql — ${meaningfulOutput(scrubSecrets(res.out)).slice(0, 160) || "no output"}`}`
            : `${tag}${action.assertion ? "assertion failed through psql" : "ran SQL through psql — failed"}`,
          status: res.ok ? "ok" : "fail",
          error: res.ok ? undefined : scrubSecrets(res.error),
        });
      } else if (action.action === "run_sql") {
        if (awaitTargetUsable) await awaitTargetUsable();
        let r = await runSql(page, applyTestInputs(applyInputs(action.sql, inputs)), serviceId);
        // A schema/relation that "does not exist" right after a recent infra change (e.g. HA just
        // enabled) may just not have finished propagating yet, not be a real error — retry a few
        // times before concluding that. Other error kinds (syntax, permissions) aren't retried.
        for (let attempt = 0; !r.ok && /does not exist/i.test(r.error || "") && attempt < 3; attempt++) {
          await page.waitForTimeout(10000);
          r = await runSql(page, applyTestInputs(applyInputs(action.sql, inputs)), serviceId);
        }
        // An ASSERTION can also be early rather than wrong. `expect rows` after a CSV import is
        // asserting on a job the Console runs asynchronously, and a 10.7M-row import outlives the
        // click that started it. Retried only for assertions, and only for the "got none" case: a
        // syntax error or a permission failure will never come good, and retrying a plain `run SQL:`
        // would re-execute a statement that may have side effects.
        for (let attempt = 0; !r.ok && action.assertion && /got none/i.test(r.error || "") && attempt < 6; attempt++) {
          await page.waitForTimeout(10000);
          r = await runSql(page, applyTestInputs(applyInputs(action.sql, inputs)), serviceId);
        }
        actions.push({
          step: i,
          did: r.ok
            ? `${tag}${action.assertion ? "assertion held" : "ran SQL"}`
            : `${tag}${action.assertion ? "assertion failed" : "ran SQL — failed"}`,
          status: r.ok ? "ok" : "fail",
          error: r.ok ? undefined : r.error,
        });
      } else if (action.action === "resolve") {
        // "[resolve: trash icon]" in a plan: an icon the page names only by its picture. Routed to
        // the same ICON_LABELS table the prose walker uses, so a hint resolves exactly when a
        // confirmed entry exists for it. Before this branch every hint fell through to "skipped",
        // including ones the table could already click.
        // Read replica sets have no name a plan can know (the Console generates it), so two hints
        // resolve structurally, both confirmed live 2026-09-25:
        //   "expand the read replica set under the primary service" — on the services list, the
        //     run's OWN service card (matched by its service ID, never the first card: the first card
        //     was the standing service once), its `show-read-replicas` toggle, then the nested
        //     `service-read-replica-card`, which opens the replica set's overview.
        //   "the replica set in the list" — on Read scaling, the set's name link in the table.
        if (/\bread replica set\b.*\b(under|expand)\b|\bexpand\b.*\breplica set\b/i.test(action.hint)) {
          // "In the Console" starts from the services list, so go there; the step before may sit on
          // any service page, where the project's Services tab does not exist.
          await page.goto(`https://console.cloud.tigerdata.com/projects/${PROJECT_ID}/services`, { waitUntil: "load", timeout: 60000 });
          await page.waitForTimeout(4000);
          const card = page.locator('[data-cy="service-card"]').filter({ hasText: serviceId }).filter({ visible: true }).first();
          const wrap = card.locator('xpath=ancestor-or-self::*[.//*[@data-cy="show-read-replicas"]][1]');
          if (!(await card.count().catch(() => 0))) {
            actions.push({ step: i, did: `${tag}no service card for ${serviceId} on this page`, status: "fail" });
            return false;
          }
          await wrap.locator('[data-cy="show-read-replicas"]').first().click({ timeout: 10000 });
          await page.waitForTimeout(2000);
          const replicaCard = page.locator('[data-cy="service-read-replica-card"]').filter({ visible: true }).first();
          if (!(await replicaCard.count().catch(() => 0))) {
            actions.push({ step: i, did: `${tag}expanded ${serviceId}'s read replica sets, but none is listed`, status: "fail" });
            return false;
          }
          await replicaCard.click({ timeout: 10000 });
          await page.waitForLoadState("networkidle", { timeout: 15000 }).catch(() => {});
          await page.waitForTimeout(2000);
          actions.push({ step: i, did: `${tag}expanded ${serviceId}'s read replica sets and opened the first (${page.url().match(/services\/([a-z0-9]{10})/)?.[1] || "?"})`, status: "ok" });
          return false;
        }
        if (/\breplica set\b.*\bin the list\b/i.test(action.hint)) {
          const link = page.locator('[data-cy="table-row-0-cell-name"] a').filter({ visible: true }).first();
          if (!(await link.count().catch(() => 0))) {
            actions.push({ step: i, did: `${tag}no read replica set in the list on this page`, status: "fail" });
            return false;
          }
          await link.click({ timeout: 10000 });
          await page.waitForLoadState("networkidle", { timeout: 15000 }).catch(() => {});
          await page.waitForTimeout(2000);
          actions.push({ step: i, did: `${tag}opened the read replica set in the list (${page.url().match(/services\/([a-z0-9]{10})/)?.[1] || "?"})`, status: "ok" });
          return false;
        }
        const icon = await resolveIconTarget(page, action.hint);
        const iconHow = icon ? (icon.ariaLabel ? `aria-label \`${icon.ariaLabel}\`` : `selector \`${icon.selector}\``) : "";
        if (!icon) {
          actions.push({ step: i, did: `${tag}no resolver for [resolve: ${action.hint}] on this page`, status: "blocked" });
        } else if (icon.destructive && (!allowDestructive || foreignServiceOnPage(page))) {
          await shot(page, `${stepBase}-before-destructive`);
          shots.push({ base: `${stepBase}-before-destructive`, caption: `Step ${i + 1}: stopped before destructive action` });
          actions.push({ step: i, did: `${tag}STOP before destructive: click icon (${iconHow}) (not on a fork)`, status: "stopped" });
          haltedBeforeDestructive = true;
          return true;
        } else {
          await icon.locator.click({ timeout: 10000 });
          await page.waitForLoadState("networkidle", { timeout: 15000 }).catch(() => {});
          await page.waitForTimeout(icon.destructive ? 5000 : 1500);
          actions.push({ step: i, did: `${tag}click icon (${iconHow}) — resolved from [resolve: ${action.hint}]`, status: "ok" });
        }
      } else if (action.action === "verify_text") {
        // No click target: the docs already backtick the exact value the reader is meant to see
        // (e.g. "marked as `Running`") — confirm it's really on the page instead of reporting a
        // false "needs an annotation" for a step that has nothing to click at all.
        const found = (await bodyText(page)).includes(action.text);
        actions.push({
          step: i,
          did: found ? `${tag}verified "${action.text}" is shown` : `${tag}"${action.text}" not found on the page`,
          status: found ? "ok" : "fail",
        });
      } else {
        actions.push({ step: i, did: `${tag}${action.action}`, status: "skipped" });
      }
    } catch (e) {
      // A click that fails because its control is disabled means the docs step left a value open
      // (e.g., "choose your strategy" / "change the configuration" then Apply/Change config) —
      // not a genuine failure. Not gated on action.destructive: that flag is about fork-routing,
      // and a submit control like "Change configuration" often isn't itself a destructive verb.
      if (action.label && (await isLabelDisabled(page, action.label))) {
        const resolved = await resolveOpenChoice(page);
        let retried = false;
        if (resolved) {
          try {
            await clickLabel(page, action.label);
            await page.waitForLoadState("networkidle", { timeout: 15000 }).catch(() => {});
            await page.waitForTimeout(action.destructive ? 5000 : 1500);
            actions.push({ step: i, did: `${tag}click \`${action.label}\` (docs left the choice open; picked an unselected option)`, status: "ok" });
            retried = true;
            // The choice this resolved may have been described by the IMMEDIATELY PRECEDING step
            // (no clickable target of its own, e.g. "Select the new `CPU / Memory` allocation"),
            // flagged blocked at the time and now resolved. Only reclassify that exact adjacent
            // step, not any earlier blocked entry in the procedure — an unrelated earlier failure
            // (e.g. an icon-only row click that never ran) must NOT be swept under this resolution;
            // in that case later clicks may have landed on the wrong target entirely and the
            // procedure should keep reading NEEDS INPUT.
            const priorBlocked = actions.find((a) => a.step === i - 1 && a.status === "blocked" && /no labeled control to target/.test(a.did));
            if (priorBlocked) {
              priorBlocked.status = "ok";
              priorBlocked.did += " — resolved opportunistically when the submit control was clicked";
            }
          } catch { /* still disabled after picking an option — fall through to the blocked report */ }
        }
        if (!retried) {
          await shot(page, `${stepBase}-blocked`); shots.push({ base: `${stepBase}-blocked`, caption: `Step ${i + 1}: blocked — needs a value the docs leave open` });
          actions.push({ step: i, did: `${tag}\`${action.label}\` is disabled — step needs a value the docs leave open`, status: "blocked" });
        }
      } else {
        if (process.env.DEBUG_FULL_ERRORS) console.error(`\n--- FULL ERROR for step ${i} action ${action.action} ---\n${e.stack || e.message}\n---\n`);
        actions.push({ step: i, did: `${tag}${action.action} ${action.label || action.text || ""}`.trim(), status: "fail", error: (e.message || "").split("\n")[0] });
      }
    }
    return false;
  }

  // A 25-minute run outlives the Console session. One expired at step 42 of 70 and the
  // remaining 28 steps failed as "no control labelled `Operations`", "no code editor on this screen",
  // "expected the url to contain /operations, but it is /login" — every one of them a login page, and
  // every one indistinguishable from a real docs bug in the report. Two earlier runs had been read as
  // a Monaco problem for the same reason.
  //
  // So: check at the top of each step, sign in again in place, and return to the service. Reported as
  // its own line, because a run that silently re-authenticated is a run whose timing you cannot trust.
  async function recoverSessionIfNeeded(i) {
    if (!landsOnLogin(page)) return false;
    // Being ON /login for an instant is not the same as being logged out. The Console can route
    // through /login while it restores a stored session, and the check above samples the url ONCE,
    // 2.5s after a navigation. A run whose session had been created seconds earlier by `npm run
    // login` still triggered recovery here, so poll before concluding anything — the same fix the
    // Monaco read-back needed for the same reason.
    for (let tries = 0; tries < 10 && landsOnLogin(page); tries++) await page.waitForTimeout(500);
    if (!landsOnLogin(page)) return false;
    await signIn(page).catch(() => {});
    if (serviceSelected) await gotoServiceById(page, serviceId).catch(() => {});
    else await gotoProject(page).catch(() => {});
    const back = !landsOnLogin(page);
    actions.push({
      step: i,
      did: back ? "the Console session had expired; signed in again and carried on" : "the Console session expired and signing in again did not take",
      status: back ? "ok" : "fail",
    });
    return back;
  }

  for (let i = 0; i < proc.steps.length && !stopped; i++) {
    // A step outside the slice is not walked and is not a finding. It has to be skipped HERE, before
    // anything else looks at it: its actions list is empty, so the structural fallbacks further down
    // treat it as a step whose control could not be found and record it `blocked` with "needs an
    // annotation". Fifty of those turned a slice whose every walked step passed into NEEDS INPUT.
    // The step still occupies its index so the report's numbering matches the plan.
    if (proc.steps[i].skipOutsideSlice) continue;

    // Ctrl-C or SIGTERM landed during the step before: report this one as the stopping point and
    // return, so test-page.mjs's teardown (fork, project sweep) runs as after a finished walk
    // (lib/stop.mjs). The verdict is `stopped`, the same as a walk halted before a destructive step.
    if (stopRequested()) {
      actions.push(stoppedLine(i));
      haltedBeforeDestructive = true;
      stopped = true;
      break;
    }

    // Is the browser still there? A run has gone quiet mid-walk with zero Chromium
    // processes alive and the node process at 0% CPU: the browser had died and the pending awaits sat
    // on a dead CDP socket, outlasting every ceiling above. A dead browser cannot be recovered from
    // mid-walk — the fork, the psql session and the page state are all gone with it — so this stops
    // the walk with a reason instead of leaving a run that looks busy for hours.
    if (page.isClosed() || page.context().browser()?.isConnected() === false) {
      actions.push({ step: i, did: "the browser died; the rest of the page could not be tested", status: "fail" });
      stopped = true;
      break;
    }
    await capped(`step ${i + 1} session check`, recoverSessionIfNeeded(i), 90000).catch(() => {});
    // Count the report lines this step produces, so a step that produces NONE can be named at the
    // end of the iteration instead of vanishing. Counting beats predicting: the step can be reported
    // from any of a dozen paths (resolvers, testInput, testRow, tab groups, its own actions), and a
    // predicate guessing which of them will fire would drift out of step with them.
    // Live progress. A plan is ONE synthetic procedure, so the per-procedure lines test-page.mjs
    // prints no longer say anything about where a long run has got to — a 39-step run went silent for
    // twenty minutes between "Walking" and the report, and the only way to tell was to look at which
    // screenshot files had appeared. The plan writes each step out, so print that.
    const stepLabel = (proc.steps[i].title || "").replace(/\s+/g, " ").slice(0, 100);
    console.log(`    [${i + 1}/${proc.steps.length}] ${stepLabel}`);

    const actionsBefore = actions.length;
    touchedBrowser = false; // per step; the tab loop resets it again per tab
    stepTouchedBrowser = false;
    const hasTabs = proc.steps[i].tabGroups && proc.steps[i].tabGroups.length > 0;
    // The icon-describing sentence is usually in the body, not the short title summary — search both.
    const stepText = `${proc.steps[i].title || ""} ${proc.steps[i].body || ""}`;
    // Matched against the TITLE only, never the body. Bodies mention connecting in passing all the
    // time: "Download the database config … you'll need the connection string to connect to your
    // service" is a DOWNLOAD step, and reading its body resolved it as a successful connect — a
    // green tick for a step that never ran, against the standing service rather than the new one.
    // The instruction lives in the title; the body is prose around it.
    const stepTitle = proc.steps[i].title || "";
    if (proc.steps[i].actions.length === 0 && !hasTabs && CONNECT_TO_SERVICE.test(stepTitle)) {
      // "Connect to your service" resolves to: be in that service's view, with the SQL editor open.
      // Before this, such a step produced NO report line at all — the procedure looked like it had
      // fewer steps than the page documents, and the SQL that followed had no service to run against.
      const r = await connectToService(page, serviceId);
      actions.push({
        step: i,
        did: r.ok
          ? `connected to service ${serviceId} (opened its SQL editor — the docs name no specific steps)`
          : `couldn't connect to service ${serviceId}`,
        status: r.ok ? "ok" : "fail",
        error: r.ok ? undefined : r.error,
      });
    } else if (proc.steps[i].actions.length === 0 && !hasTabs && UNTARGETABLE.test(stepText)) {
      const icon = await resolveIconTarget(page, stepText);
      const iconHow = icon ? (icon.ariaLabel ? `aria-label \`${icon.ariaLabel}\`` : `selector \`${icon.selector}\``) : "";
      if (icon && icon.destructive && !allowDestructive) {
        // Not on a fork: never mutate the standing service — same protection every other
        // destructive action gets, just reached via icon resolution instead of a tokenized click.
        await shot(page, `${prefix}-step${i + 1}-before-destructive`); shots.push({ base: `${prefix}-step${i + 1}-before-destructive`, caption: `Step ${i + 1}: stopped before destructive action` });
        actions.push({ step: i, did: `STOP before destructive: click icon (${iconHow}) (not on a fork)`, status: "stopped" });
        haltedBeforeDestructive = true;
        stopped = true;
      } else if (icon) {
        try {
          await icon.locator.click({ timeout: 10000 });
          // A destructive icon click (e.g. the trash can next to a cross-region backup) often opens
          // an "Are you sure?" dialog rather than mutating immediately — confirmed live. Follow
          // through so the action actually completes instead of leaving the dialog open.
          const confirmBtn = page.getByRole("button", { name: "Confirm", exact: true }).filter({ visible: true });
          await page.waitForTimeout(1000);
          if (await confirmBtn.count()) await confirmBtn.first().click({ timeout: 10000 });
          await page.waitForLoadState("networkidle", { timeout: 15000 }).catch(() => {});
          await page.waitForTimeout(5000);
          actions.push({ step: i, did: `click icon (${iconHow}) — resolved from "${proc.steps[i].title}"`, status: "ok" });
        } catch (e) {
          actions.push({ step: i, did: `couldn't click icon (${iconHow})`, status: "fail", error: (e.message || "").split("\n")[0] });
        }
      } else {
        // No icon matched. If the step points into a list ("click a job ID in the list"), the
        // target is data, not a label — resolve a row from the live page. Gated on the phrasing
        // naming a list/table so an unrelated unlabeled step can never click an arbitrary link
        // and report a hollow pass.
        const item = LIST_TARGET.test(stepText)
          ? await resolveListItemTarget(page)
          : PROJECT_CHOICE.test(stepText)
          ? await resolveProjectChoice(page)
          : null;
        if (item) {
          try {
            await item.locator.click({ timeout: 10000 });
            await page.waitForLoadState("networkidle", { timeout: 15000 }).catch(() => {});
            await page.waitForTimeout(2500);
            actions.push({ step: i, did: `clicked \`${item.label}\` (docs left the choice open; picked one that differs from the current state)`, status: "ok" });
          } catch (e) {
            actions.push({ step: i, did: `couldn't click \`${item.label}\``, status: "fail", error: (e.message || "").split("\n")[0] });
          }
        } else {
          actions.push({ step: i, did: `couldn't perform "${proc.steps[i].title}" — no labeled control to target (icon/unlabeled step; needs an annotation)`, status: "blocked" });
        }
      }
    }
    // A step annotated testInput needs a value the docs deliberately withhold ("type the email
    // address of the person you want to add"). Fill it BEFORE the step's own clicks, matching the
    // documented order: the submit control stays disabled until the field has a value, so running
    // the click first would just report a blocked step.
    // Pin this step to the row identified by a test value we own. If the row isn't there, the
    // step's clicks are SKIPPED rather than run page-wide: "click ⋮ next to the person" with no
    // row resolved would act on whoever happens to be listed first.
    // rowScope/rowUsed are per-step (a new step re-resolves its row), but rowPinned is NOT reset:
    // once a step has pinned a row, the confirm dialog that follows in a LATER step belongs to that
    // same row, and resetting the permission there left "In `Remove user`, click `Remove`" stopping
    // before destructive with no fork to fall back on.
    // A `use the row for $X` step carries NO actions of its own — the grammar puts the pin on its
    // own numbered line and the click that needs it on the NEXT one, which is how every plan is
    // written. Clearing the scope unconditionally here therefore threw the pin away before its click
    // ever ran: `click \`⋮\` > \`Remove\`` fell through to a page-wide clickLabel, and `⋮` is a glyph
    // the DOM never contains, so it could only ever fail. It reported green instead, because the
    // clickLabel attempt-loop was swallowing the error at the time.
    //
    // So an UNSPENT pin survives into the following step. Only a pin that a click has already used,
    // or a step that pins a row of its own, clears it.
    //
    // But it survives ONE step, not the rest of the walk. A row click that FAILS never sets rowUsed
    // — deliberately, so the next click cannot escape to a page-wide search — and nothing else
    // cleared the pin, so a failed `click \`⋮\`` left every later step searching inside a table row.
    // On the members page that turned `click \`Security\`` into "no control labelled Security on the
    // page" with the nav link plainly on screen: two failures that read exactly like docs bugs and
    // were neither. The grammar puts a pin on its own line and its click on the next, so one step is
    // the whole life of a pin.
    if (rowUsed || proc.steps[i].testRow || (rowScope && i > pinStep + 1)) {
      rowScope = null;
      rowUsed = false;
    }
    let skipStepActions = false;
    if (proc.steps[i].testRow && !stopped) {
      const name = proc.steps[i].testRow;
      const value = testInputValue(name);
      if (value == null) {
        actions.push({ step: i, did: `needs test input \`${name}\` to identify the row — set ${testInputEnvVar(name)}`, status: "blocked" });
        skipStepActions = true;
      } else {
        rowScope = await resolveTestRow(page, value);
        if (rowScope) {
          rowPinned = true;
          pinValue = value;
          pinStep = i;
          actions.push({ step: i, did: `pinned to the row for \`${value}\``, status: "ok" });
        } else {
          actions.push({ step: i, did: `no row containing \`${value}\` on this page — skipped rather than acting on an unidentified row`, status: "blocked" });
          skipStepActions = true;
          // Drop the previous pin as well: the 2026-11-23 members runs kept it, so the role change of
          // the next step was recorded under the removed invitee's address and could not be restored.
          rowPinned = false;
          pinValue = null;
          pinBlockedAt = i;
        }
      }
    }
    // A pin that found no row takes the step written for it down with it. The grammar puts the pin
    // on its own line and its click on the next; running that click unscoped acts on whichever row
    // the page offers, which on the members page is a real person.
    if (pinBlockedAt >= 0 && pinBlockedAt === i - 1 && !skipStepActions && !stopped) {
      actions.push({ step: i, did: "skipped: the step before it found no row to pin, so this step did not act on an unidentified row", status: "blocked" });
      skipStepActions = true;
    }
    if (proc.steps[i].testInput && !stopped) {
      const name = proc.steps[i].testInput;
      const value = testInputValue(name);
      if (value == null) {
        actions.push({ step: i, did: `needs test input \`${name}\` — set ${testInputEnvVar(name)}`, status: "blocked" });
      } else {
        const where = await fillTestInput(page, value);
        actions.push(
          where
            ? { step: i, did: `typed test input \`${name}\` into the \`${where}\` field`, status: "ok" }
            : { step: i, did: `couldn't find a field for test input \`${name}\``, status: "fail" }
        );
      }
    }
    // Snapshot this page's switches before a step that acts, so whatever it flips can be put back at
    // the end. UNCONDITIONAL, and deliberately not a decision: restoring a switch you flipped is
    // hygiene of the same kind as deleting the fork, not cleverness. It used to be opt-in per step,
    // which made the SAFE behaviour the one an author had to remember — and forgetting it leaves a
    // project-wide setting like MFA enforcement on for every member, long after the run exits.
    //
    // One snapshot per URL, keeping the FIRST: a later step on the same page may see a switch this
    // run already flipped, and restoring to that would leave the change in place.
    if (!stopped && !skipStepActions && !toggleRestores.some((t) => t.url === page.url())) {
      // Bounded: this and collapseSqlEditor are the only awaits in the step loop outside the ceiling,
      // and they are where a run went silent for twelve minutes after the ceiling had already recorded
      // its failure — the loop could not advance to print the next step.
      const snap = await capped("switch snapshot", snapshotSwitches(page), 30000).catch(() => null);
      if (snap) toggleRestores.push(snap);
    }
    const stepActions = proc.steps[i].actions;
    for (let a = 0; a < stepActions.length; a++) {
      if (skipStepActions) break;
      try {
        if (await capped(`step ${i + 1}`, runAction(stepActions[a], i, undefined))) { stopped = true; break; }
      } catch (e) {
        // The step is abandoned, not the page: later sections are usually independent, and a run that
        // stops dead reports nothing about them. Marked BEFORE the push, so the push itself passes the
        // filter and whatever the runaway handler reports afterwards does not.
        abandonedSteps.add(i);
        actions.push({ step: i, did: `${e.message}`, status: "fail" });
      }
      // Check status AFTER each action for service creation. Do this before the final step
      // to avoid page-state changes (like download dialogs) masking the status.
      if (!stopped && sawDestructiveCreate && waitedThisStep !== i && a === stepActions.length - 2 && (await statusBadge(page, `${TRANSIENT_BADGE}|${READY_BADGE}`))) {
        waitedThisStep = i;
        const r = await waitUntilStatusClears(page, { timeout: statusBudget() });
        if (!r.cleared) {
          actions.push({ step: i, did: `created resource still shows \`${r.badge}\` after ${Math.round(r.waitedMs / 60000)}min, continuing anyway`, status: "blocked" });
          sawDestructiveCreate = false;
        }
      }
    }
    // Each <Tabs> alternative documents a different way to do the same thing, and must be verified
    // independently — re-navigating to a clean starting point before each one so an earlier tab's
    // UI-mode change (e.g. toggling Data view) can't leak into the next tab's attempt and produce a
    // failure that's really just cross-tab interference, not a broken documented path.
    if (!stopped && hasTabs) {
      // A psql session opened INSIDE a tab belongs to that alternative alone. Letting it outlive the
      // loop routes a LATER shared step's SQL through a connection the reader may never have opened:
      // on the quickstart, "Pick one way to run SQL" ends on the psql tab, so "Confirm you're
      // connected" ran `SELECT CURRENT_DATE;` through psql and never exercised the Console editor the
      // step before it had just tested. Console is the route the page leads with, and it went unrun.
      // Restoring the pre-loop value keeps the case the docs DO intend: a session opened by a step's
      // own action persists into later steps, which is 35 procedures against this one shape's 3
      // (install-toolkit, install-timescaledb, downgrade, entire-database; major-upgrade even has a
      // later step named "Exit your psql session"). Measured over the corpus, not assumed.
      const psqlBeforeTabs = psqlSession;
      for (const group of proc.steps[i].tabGroups) {
        // A tab the docs mark untestable is not walked. Without this, the only way to stop testing one
        // alternative was to special-case it in the walker, which meant the walker carried knowledge of
        // a specific Console feature; a page can now say so itself. Reported, never silent — a tab that
        // vanished from the report would read as "not documented" rather than "deliberately not tested".
        if (group.test === "manual") {
          actions.push({
            step: i,
            did: `[${group.label}] skipped — the docs mark this tab \`test="manual"\`${group.requires ? ` (requires: ${group.requires})` : ""}`,
            status: "skipped",
          });
          continue;
        }
        await gotoServiceById(page, serviceId);
        // Re-navigating resets the BROWSER, but psqlSession is state too: leave it set and the next
        // tab's SQL runs through the previous tab's psql connection, which is the cross-tab leak this
        // loop exists to prevent. It has gone unnoticed only because psql is listed last wherever it
        // appears — reorder the tabs on any such page and the bug shows up.
        psqlSession = null;
        touchedBrowser = false;
        let tabStopped = false;
        for (const action of group.actions) {
          if (await runAction(action, i, group.label)) { tabStopped = true; stopped = true; break; }
        }
        // Instructions inside this tab that produced no action. Named, not omitted: the psql tab
        // documents "Install psql" and the run said nothing at all about it, so the report showed two
        // of the tab's three documented instructions and looked complete.
        for (const text of group.unresolved || []) {
          actions.push({
            step: i,
            did: `[${group.label}] skipped — nothing to act on in "${text}".${annotationHint(text)}`,
            status: "skipped",
          });
        }
        if (!tabStopped && touchedBrowser) {
          const base = `${prefix}-step${i + 1}-${slugify(group.label)}`;
          await shot(page, base);
          shots.push({ base, caption: `Step ${i + 1}: ${group.label}` });
        }
        if (stopped) break;
      }
      psqlSession = psqlBeforeTabs;
    }
    if (!stopped && sawDestructiveCreate && waitedThisStep !== i) {
      // Only wait on a TRANSIENT badge (queued/provisioning/creating). A `Ready` badge means the
      // resource is done, so the obligation is discharged rather than waited on.
      if (await statusBadge(page, TRANSIENT_BADGE)) {
        waitedThisStep = i;
        const r = await waitUntilStatusClears(page, { timeout: statusBudget() });
        sawDestructiveCreate = !r.cleared;
        if (!r.cleared) actions.push({ step: i, did: `created resource still shows \`${r.badge}\` after ${Math.round(r.waitedMs / 60000)}min, continuing anyway`, status: "blocked" });
      } else if (await statusBadge(page, READY_BADGE)) {
        sawDestructiveCreate = false;
      }
    }
    // This step produced no report line at all: no backtick label, no SQL, no tabs, and no structural
    // resolver recognised its phrasing. Say so. A procedure that quietly reports fewer steps than the
    // page documents reads as complete when it isn't — the same failure as a dropped <NumberedItem>,
    // arrived at from the other end.
    //
    // 165 of the 797 steps in the Console-scope queue land here. Most are off-Console work (shell
    // commands, a Python venv, installing the CLI, printing recovery codes) and want test="manual"
    // with a requires=; the rest are tool gaps worth fixing one at a time. Either way, naming them is
    // what turns an invisible hole into a worklist.
    // Reported as SKIPPED, with the reason attached. Not "blocked": nothing obstructed the tool,
    // there was simply nothing here to act on, and dragging the page's verdict down for documenting
    // a shell command is wrong. Not "ok" either: that asserts a step was verified when it was not.
    if (actions.length === actionsBefore) {
      actions.push({
        step: i,
        did: `skipped — nothing to act on in "${(proc.steps[i].title || "").slice(0, 70)}".${annotationHint(stepText)}`,
        status: "skipped",
      });
    }
    // The step's own end-of-step shot. For a TABBED step this fires after the tab loop, so it shows
    // whatever the last tab left behind — and if that tab was terminal-only, that is the tab before
    // it. Requiring touchedBrowser (the last tab) as well as stepTouchedBrowser (the step) keeps the
    // shot when the last alternative actually drove the page, and drops it when the frame would be
    // stale. Each tab already has its own shot, so nothing goes unevidenced either way.
    // A PASSING assertion step has nothing to photograph: `expect rows:` compiles to a DO block that
    // either raises or returns nothing, so its evidence is the text already in the report, and the
    // picture is one more shot of the same SQL panel. A FAILING one is worth a picture, because the
    // panel holds the error.
    const stepActs = proc.steps[i].actions || [];
    const assertionOnly = stepActs.length > 0 && stepActs.every((a) => a.assertion);
    const stepFailed = actions.some((a) => a.step === i && (a.status === "fail" || a.status === "blocked"));
    if (!stopped && stepTouchedBrowser && (!hasTabs || touchedBrowser) && !(assertionOnly && !stepFailed)) {
      // doc-update shoots the moments a PAGE needs, not every step: an image the page already
      // publishes (located by the labels around it, never by a hand-written step number), plus one per
      // change of view so a reader gets each screen once. evidence mode shoots every step.
      let refreshes = null;
      let take = true;
      if (SHOT_MODE === "doc-update") {
        for (const a of stepActs) {
          if ((a.action === "click" || a.action === "toggle") && docAssetByLabel.has(a.label)) {
            refreshes = docAssetByLabel.get(a.label);
          }
        }
        const view = await viewSignature(page);
        take = !!refreshes || (view && view !== lastCapturedView);
        if (take) lastCapturedView = view;
      }
      if (take) {
        await capped(`step ${i + 1} screenshot`, shot(page, `${prefix}-step${i + 1}`), 90000).catch((e) =>
          actions.push({ step: i, did: e.message, status: "blocked" }),
        );
        shots.push({
          base: `${prefix}-step${i + 1}`,
          caption: refreshes ? `Step ${i + 1} — refreshes ${refreshes.split("/").pop()}` : `Step ${i + 1}`,
          refreshes: refreshes || undefined,
        });
      }
    }
    // Put the SQL editor away at the END of the step, once its result has been photographed. The
    // result panel IS this step's evidence, so collapsing earlier would photograph an empty page;
    // collapsing later means no following step meets the panel covering a control it needs.
    await capped("collapse the SQL editor", collapseSqlEditor(page), 30000).catch(() => {});

    // --fail-fast: stop at the first failing step. OFF by default, deliberately. A full run is the
    // valuable one: this page's last run found two unrelated bugs in one pass (a quoting bug in an
    // assertion at step 39, the wrong control at 56), and stopping at the first would have cost a
    // second fork and half an hour to learn the same thing. Sections after a failure also keep
    // testing — tiering and high availability both passed AFTER step 39 failed, coverage that
    // stopping would have hidden. It is for iterating on a failure you already know about.
    if (failFast && actions.some((a) => a.step === i && a.status === "fail")) {
      actions.push({ step: i, did: "stopped here: --fail-fast", status: "stopped" });
      stopped = true;
    }
  }

  const failed = actions.some((a) => a.status === "fail");
  const blocked = actions.some((a) => a.status === "blocked");
  const verdict = failed ? "fail" : blocked ? "blocked" : haltedBeforeDestructive ? "stopped" : "pass";
  // Put any role/dropdown changes back. The docs say the change commits immediately, so without
  // this a test run would permanently alter a real member's permissions.
  for (const d of dropdownRestores.reverse()) {
    try {
      // page, not page.locator("main") — the Console has no <main>, and a restore that silently
      // scopes to nothing would leave a real member's role changed while reporting success.
      // Go back to the page the row was on before looking for it. This restore runs after the last
      // step, and a plan does not have to end where it changed the drop-down: the members plan
      // finishes on Security > Authentication, two steps past the members table. Resolving against
      // whatever page the walk ended on found no row and left a real person's role changed, which is
      // the one outcome this block exists to prevent.
      let scope = d.pinValue ? await resolveTestRow(page, d.pinValue) : page;
      if (!scope && d.url && page.url() !== d.url) {
        await page.goto(d.url, { waitUntil: "domcontentloaded", timeout: 60000 }).catch(() => {});
        await page.waitForTimeout(3000);
        scope = await resolveTestRow(page, d.pinValue);
      }
      if (!scope) {
        actions.push({ step: proc.steps.length - 1, did: `couldn't find the row for \`${d.pinValue}\` to restore its \`${d.original}\` role — check it by hand`, status: "fail" });
        continue;
      }
      const now = await dropdownValue(scope);
      if (now === d.original) continue;
      const r = await selectOtherOption(page, scope, { want: d.original });
      actions.push({
        step: proc.steps.length - 1,
        did: r.chosen === d.original
          ? `restored the dropdown to \`${d.original}\` after the test`
          : `COULD NOT restore the dropdown to \`${d.original}\` (still \`${r.after}\`) — fix it by hand`,
        status: r.chosen === d.original ? "ok" : "fail",
      });
    } catch (e) {
      actions.push({ step: proc.steps.length - 1, did: `failed to restore a dropdown — check it by hand`, status: "fail", error: (e.message || "").split("\n")[0] });
    }
  }

  // Put any test="restore-after" toggles back. Runs newest-first, and re-navigates if the walk has
  // moved on, because leaving a project-wide switch flipped would change behaviour for every member
  // of the project long after this run finished.
  for (const snap of toggleRestores.reverse()) {
    try {
      if (!page.url().startsWith(snap.url)) {
        await page.goto(snap.url, { waitUntil: "domcontentloaded", timeout: 45000 });
        await page.waitForTimeout(2500);
      }
      const sw = switchesIn(page);
      for (let k = 0; k < snap.states.length; k++) {
        if ((await sw.count()) <= k) break;
        const now = await switchChecked(sw.nth(k));
        if (now === snap.states[k]) continue;
        // Same Chakra shape as above: click the enclosing label, not the 1x1 input.
        const restoreLabel = sw.nth(k).locator("xpath=ancestor::label[1]");
        await ((await restoreLabel.count()) ? restoreLabel.first() : sw.nth(k)).click({ timeout: 10000 });
        await page.waitForTimeout(2000);
        const after = await switchChecked(sw.nth(k));
        actions.push({
          step: proc.steps.length - 1,
          did: after === snap.states[k]
            ? `restored the toggle to ${snap.states[k] ? "on" : "off"} after the test`
            : `COULD NOT restore the toggle to ${snap.states[k] ? "on" : "off"} — it is still ${after ? "on" : "off"}`,
          status: after === snap.states[k] ? "ok" : "fail",
        });
      }
    } catch (e) {
      actions.push({ step: proc.steps.length - 1, did: `failed to restore a toggle — check it by hand`, status: "fail", error: (e.message || "").split("\n")[0] });
    }
  }

  // A procedure that switched projects leaves the session pointing at the wrong one, and the active
  // project persists — that's what makes a later service URL silently redirect to another project's
  // services list. Switch back before returning so this procedure can't contaminate the next.
  if (!page.url().includes(PROJECT_ID)) {
    await gotoProject(page).catch(() => {});
    actions.push({ step: proc.steps.length - 1, did: `switched back to project ${PROJECT_ID} so the next procedure starts clean`, status: "ok" });
  }

  // projectScoped travels with the result so the report can say plainly that these steps ran
  // against the real project: a service fork cannot isolate project-level changes, and claiming
  // fork protection for them would be a lie.
  // Step titles ride along so the report can say WHICH step each row belongs to. Without them every
  // SQL row read "ran SQL" — on a 39-step plan that is twenty identical lines and no way to tell the
  // \COPY from the CREATE from the tiering policy. A plan writes each step out in full, so there is
  // no reason for the report to throw that away.
  return { title: proc.title, verdict, actions, shots, stepTitles: proc.steps.map((s) => s.title || ""), pendingCreate: sawDestructiveCreate, createdServiceId, createdServiceName: createdServiceId ? namedCreated : null, projectScoped };
}