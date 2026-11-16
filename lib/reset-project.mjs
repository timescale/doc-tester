// Project-level teardown. The docs describe the EMPTY state of every create-flow ("click `Create
// IP Allow List`"), but the Console shows a different CTA once even one row exists ("Create new").
// So a page tested against a project holding rows from earlier runs reports a label finding that
// is specific, confident and wrong.
//
// A service fork can't fix this: IP allow lists, VPCs and private endpoints are PROJECT-scoped, and
// a fork is a new service inside the same project. The only way to hold the documented state is to
// reset the project to empty after each page.
//
// Not driven by the Tiger CLI, unlike lib/fork.mjs: `tiger` has no vpc/allow-list commands (its
// help advertises VPCs but exposes only auth/config/db/mcp/service), so this goes through the
// Console UI.

// Sub-nav labels under project Security, in teardown order: detach-style resources first, since an
// allow list attached to a service can refuse deletion while the attachment stands.
const SECURITY_TABS = ["IP Allow Lists", "Private Endpoints", "VPC Peering (AWS)"];

// Each resource names its own teardown verb: a VPC offers "Delete VPC", but a private endpoint
// offers "Disconnect" and nothing matching delete/remove at all — so a delete-only vocabulary
// reported "no delete item in ⋮ menu" and left a real endpoint standing.
const DELETE_LABEL = /^(delete|remove|terminate|detach|disconnect|unattach|revoke)\b/i;

// These tables are NOT HTML tables — the VPC tab renders zero <table>/<tbody>/<tr> elements and is
// an ARIA grid of divs. A `tbody tr` lookup therefore reported "0 rows, nothing to clean" while
// vpc-33749 sat in plain view, which is the silent-false-negative shape that makes a teardown worse
// than none. Rows carry a stable data-cy instead: table-row-0, table-row-1, … each holding
// table-row-0-cell-<field> children, so the row containers are the ones WITHOUT "-cell-".
import { landsOnLogin, signIn, consoleCredentials } from "./auth.mjs";

const ROW = '[data-cy^="table-row-"]:not([data-cy*="-cell-"])';

// Row ⋮ menus carry no accessible name and never contain the ⋮ character (confirmed live), so only
// a data-cy hook finds them — and the hook is resource-scoped: contextual-menu-VPC-button-open.
// Plain `contextual-menu-button-open` is the HEADER's project switcher, so a teardown reaching for
// that name opens the project menu and clicks "Rename project" territory instead of a row action.
// The credentials table on Settings names its trigger differently: `client-credentials-context-menu`
// (confirmed live 2026-10-07). Both are only ever looked up INSIDE a row, so neither can reach the header.
const ROW_MENU = '[data-cy^="contextual-menu-"][data-cy$="-button-open"], [data-cy="client-credentials-context-menu"]';

async function visibleRows(page) {
  const rows = page.locator(ROW);
  const out = [];
  for (let i = 0; i < (await rows.count()); i++) {
    const row = rows.nth(i);
    const text = (await row.innerText().catch(() => "")).replace(/\s+/g, " ").trim();
    if (text) out.push({ row, text });
  }
  return out;
}

// Wait until the table STOPS changing before believing a row count. These tables populate well after
// domcontentloaded — a fixed 4s wait read zero rows on a tab that really held a freshly created allow
// list, so the teardown reported "0 removed, 0 remaining" and certified a dirty project as clean. A
// teardown that cannot see a resource is indistinguishable from one that cleaned it, which is the
// most dangerous shape this code can take.
//
// Counts are compared across consecutive polls rather than matched against any per-resource
// empty-state string, so nothing here breaks when that copy is reworded.
async function settledRows(page, { minStable = 3, intervalMs = 1500, timeoutMs = 30000 } = {}) {
  let last = -1;
  let stable = 0;
  const maxPolls = Math.ceil(timeoutMs / intervalMs);
  for (let poll = 0; poll < maxPolls; poll++) {
    await page.waitForTimeout(intervalMs);
    const rows = await visibleRows(page);
    if (rows.length === last) {
      stable++;
      if (stable >= minStable) return { rows, settled: true };
    } else {
      stable = 0;
      last = rows.length;
    }
  }
  return { rows: await visibleRows(page), settled: false };
}

// Open a tab by clicking its sub-nav label rather than by URL. Only `ipAllowList` is guessable;
// `/security/vpcPeering` and `/security/privateEndpoints` both silently redirect to /services, so a
// URL-built teardown would report "0 rows, nothing to clean" while sitting on the services list.
async function openTab(page, projectId, label) {
  const url = `https://console.cloud.tigerdata.com/projects/${projectId}/security`;
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.waitForTimeout(4000);
  // A dead session redirects here, and a login page has no sub-nav — which this function used to
  // report as "no sub-nav item", the caller swallowed, and the run printed as "project already
  // empty". An ip-allow-list run did exactly that: its pre-sweep saw nothing, the previous run's
  // allow list was still there, and the leftover then made step 6 pass on residue while the create
  // steps failed. A sweep that cannot see the project must say so, never imply it is clean.
  if (landsOnLogin(page)) {
    await signIn(page).catch(() => {});
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 }).catch(() => {});
    await page.waitForTimeout(4000);
  }
  if (landsOnLogin(page)) return { ok: false, why: "redirected to the login page — the sweep could not see the project" };
  // waitFor, not count(): a fixed sleep then an instantaneous count reported "no sub-nav item" for
  // every tab on a Console that just hadn't painted yet, which made the teardown skip all three tabs
  // and report "0 removed, ? remaining" — a clean bill of health for a project it never looked at.
  const nav = page.getByText(label, { exact: true }).first();
  try {
    await nav.waitFor({ state: "visible", timeout: 15000 });
  } catch {
    return { ok: false, why: `no "${label}" sub-nav item after 15s` };
  }
  await nav.click();
  await page.waitForTimeout(3500);
  return { ok: true, url: page.url() };
}

// Confirm dialogs state `Type "X" to confirm`, and that string is authoritative — row text can run
// a name straight into an adjacent column, making it look longer than it is.
async function confirmDialog(page) {
  const dlg = page.locator('[role="dialog"]').last();
  if (!(await dlg.count())) return false;
  const text = await dlg.innerText().catch(() => "");
  const needed = text.match(/type\s+"([^"]+)"\s+to\s+confirm/i)?.[1];
  if (needed) {
    const box = dlg.locator("input, textarea").last();
    if (await box.count()) await box.fill(needed);
    await page.waitForTimeout(400);
  }
  for (const b of await dlg.getByRole("button").all()) {
    const t = (await b.innerText().catch(() => "")).trim();
    if (DELETE_LABEL.test(t) || /^confirm$/i.test(t)) {
      if (await b.isEnabled().catch(() => false)) {
        await b.click();
        await page.waitForTimeout(3000);
        return true;
      }
    }
  }
  return false;
}

// Delete one row. Returns the label of whatever it clicked, or null with a reason.
async function deleteRow(page, row, dryRun) {
  const menu = row.locator(ROW_MENU).first();
  if (!(await menu.count())) {
    // Some tables put a bare Delete/Detach button in the last cell instead of a ⋮ menu.
    for (const b of await row.getByRole("button").all()) {
      const t = (await b.innerText().catch(() => "")).trim();
      if (DELETE_LABEL.test(t)) {
        if (dryRun) return { would: t };
        await b.click();
        await page.waitForTimeout(1500);
        await confirmDialog(page);
        return { did: t };
      }
    }
    return { skipped: "no ⋮ menu and no delete button in the row" };
  }
  await menu.click();
  await page.waitForTimeout(1200);
  // Scope to the menu that just opened. Enumerating [role=menuitem] page-wide also collected the
  // HEADER menus, so a private endpoint's options read "Ops view, Data view, Attach service, …" —
  // mixing global nav into a row's action list, one Escape away from clicking the wrong thing.
  const open = page.locator('[role="menu"]:visible').last();
  const items = (await open.count()) ? open.locator('[role="menuitem"], button, a') : page.locator('[role="menuitem"]');
  const found = [];
  for (const mi of await items.all()) {
    const t = (await mi.innerText().catch(() => "")).replace(/\s+/g, " ").trim();
    if (t) found.push(t);
  }
  const target = found.find((t) => DELETE_LABEL.test(t));
  if (!target) {
    await page.keyboard.press("Escape");
    return { skipped: `no teardown item in ⋮ menu (saw: ${found.join(", ") || "nothing"})` };
  }
  // The item can be PRESENT but DISABLED — a private endpoint's `Disconnect` is greyed out while
  // something still depends on it. Clicking anyway just burns Playwright's 30s timeout and throws,
  // so check first and report the resource as blocked rather than pretending it's gone.
  const item = items.filter({ hasText: target }).first();
  if (!(await item.isEnabled().catch(() => false))) {
    await page.keyboard.press("Escape");
    return { skipped: `\`${target}\` is disabled — resource is still in use or mid-transition` };
  }
  if (dryRun) {
    await page.keyboard.press("Escape");
    return { would: target };
  }
  await item.click({ timeout: 10000 });
  await page.waitForTimeout(1500);
  await confirmDialog(page);
  return { did: target };
}

// Reset every project-level security resource to empty, so the next page starts in the state the
// docs actually describe. dryRun reports what it WOULD delete and touches nothing.
export async function resetProjectSecurity(page, projectId, { dryRun = false } = {}) {
  const report = [];
  for (const label of SECURITY_TABS) {
    const opened = await openTab(page, projectId, label);
    if (!opened.ok) {
      report.push({ tab: label, error: opened.why });
      continue;
    }
    const entry = { tab: label, url: opened.url, rows: [] };
    // Never decide "nothing here" from a table that is still filling in.
    const first = await settledRows(page);
    if (!first.settled) entry.warning = "table never settled — row count may be incomplete";
    if (dryRun) {
      for (const r of first.rows) {
        entry.rows.push({ text: r.text.slice(0, 80), ...(await deleteRow(page, r.row, true)) });
      }
      entry.remaining = first.rows.length;
      report.push(entry);
      continue;
    }
    // Re-read rows each pass: deleting one re-renders the table, so a stale handle points nowhere.
    // `stuck` holds the identifying text of rows we could not act on, so one un-actionable row is
    // skipped rather than ending the tab — an earlier `break` here meant a row with an unrecognised
    // menu verb hid every row after it, silently leaving the project dirty.
    const stuck = new Set();
    let known = first.rows;
    for (let guard = 0; guard < 40; guard++) {
      const rows = known.filter((r) => !stuck.has(r.text));
      if (!rows.length) break;
      // One unco-operative row must not abort the teardown: the first real run threw on a disabled
      // menu item and never reached the VPC tab at all, leaving the project dirtier than if it had
      // done nothing while reporting a crash instead of a state.
      let outcome;
      try {
        outcome = await deleteRow(page, rows[0].row, false);
      } catch (e) {
        outcome = { skipped: `error: ${(e.message || "").split("\n")[0]}` };
        await page.keyboard.press("Escape").catch(() => {});
      }
      entry.rows.push({ text: rows[0].text.slice(0, 80), ...outcome });
      if (outcome.skipped) {
        stuck.add(rows[0].text);
        continue;
      }
      // Re-read after a deletion, waiting for the re-render: comparing against an unsettled table
      // both hides rows still to delete and makes a successful delete look like it didn't take.
      const after = await settledRows(page);
      known = after.rows;
      if (!after.settled) entry.warning = "table never settled — row count may be incomplete";
      if (known.some((r) => r.text === rows[0].text)) stuck.add(rows[0].text); // deletion didn't take
    }
    entry.remaining = known.length;
    report.push(entry);
  }
  return report;
}
// Pending project invitations, which resetProjectSecurity does NOT cover: they live on Members, not
// under Security, so "project already empty" was reported by a run whose own invite was still
// standing. That is not cosmetic. The Console refuses a second invite to the same address ("That
// email has already been added." with `Invite member` disabled), so one leftover invite makes the
// NEXT run's invite step blocked and every step after it fail — two runs of the members plan were
// lost to exactly this before it was written.
//
// Scoped to the addresses THIS RUN owns, never to whatever is pending. The real project has real
// people in it, and a pending invite to a colleague is not residue. Two independent guards:
// the address must be one we were given, and the row must still say `Resend invitation`, which only
// a pending invite does — an accepted member is never touched.
const PENDING_MARKER = /Resend invitation/;

export async function sweepPendingInvites(page, projectId, addresses) {
  const wanted = (addresses || []).filter(Boolean);
  if (!wanted.length) return [];
  const out = [];
  for (const addr of wanted) {
    await page.goto(`https://console.cloud.tigerdata.com/projects/${projectId}/members`, { waitUntil: "domcontentloaded" }).catch(() => {});
    await page.waitForTimeout(3000);
    const row = page.locator('[role="row"], tr').filter({ visible: true }).filter({ hasText: addr });
    if (!(await row.count().catch(() => 0))) { out.push({ address: addr, state: "absent" }); continue; }
    const text = ((await row.first().textContent().catch(() => "")) || "").replace(/\s+/g, " ").trim();
    if (!PENDING_MARKER.test(text)) { out.push({ address: addr, state: "accepted member — left alone" }); continue; }
    try {
      // `⋮` carries no accessible name and the DOM never contains the glyph, so the trigger only
      // resolves structurally — the same locator the walker uses for a pinned row.
      const trigger = row.first()
        .locator('[data-cy="contextual-menu-button-open"], [data-cy*="context-menu"], [aria-haspopup="menu"]')
        .filter({ visible: true });
      if (!(await trigger.count())) { out.push({ address: addr, state: "no row menu — left in place" }); continue; }
      await trigger.first().click({ timeout: 10000 });
      await page.waitForTimeout(800);
      await page.getByRole("menuitem", { name: DELETE_LABEL }).or(page.getByRole("button", { name: DELETE_LABEL })).filter({ visible: true }).first().click({ timeout: 10000 });
      await page.waitForTimeout(1200);
      // The confirm dialog. Scoped to the dialog so it cannot match the row's own link again.
      const dlg = page.getByRole("dialog").or(page.getByRole("alertdialog")).filter({ visible: true });
      if (await dlg.count()) await dlg.last().getByRole("button", { name: DELETE_LABEL }).filter({ visible: true }).first().click({ timeout: 10000 });
      await page.waitForTimeout(2500);
      // Verify from a fresh load rather than trusting the click: this whole function exists because
      // a removal that did not take was reported as done.
      await page.goto(`https://console.cloud.tigerdata.com/projects/${projectId}/members`, { waitUntil: "domcontentloaded" }).catch(() => {});
      await page.waitForTimeout(3000);
      const left = await page.locator('[role="row"], tr').filter({ visible: true }).filter({ hasText: addr }).count().catch(() => 1);
      out.push({ address: addr, state: left === 0 ? "removed" : "removal did not take — left in place" });
    } catch (e) {
      await page.keyboard.press("Escape").catch(() => {});
      out.push({ address: addr, state: `error: ${(e.message || "").split("\n")[0]}` });
    }
  }
  return out;
}

// Client credentials, which neither sweep above covers: they live under project Settings, and a
// fork cannot isolate them any more than it can an allow list. Until now the fork-services plan
// deleted its own credential with five steps the page never names, which the linter flagged on
// every run. Teardown is the tool's job, as it is for the fork itself and for every other
// project-level object.
//
// Ownership, so a credential a person keeps in the project is never touched. A row is the run's
// when its `Issued by` names the account the tool signs in as AND either its public key was not in
// the table when the run started (listCredentials before, sweepCredentials after) or its name is
// the plan's own credential input (client-credentials renames to it, so a crashed run can leave one
// by that name). Everything else issued by the account is reported and left alone.
//
// `popsql-<id>` is NOT residue. The Console keeps one credential by that name for its own SQL
// editor and recreates it the moment it is missing: deleting it on 2026-10-07 produced a fresh one
// with the same name and a new key within the second. It is excluded by name, whatever its age.
const CONSOLE_MANAGED_CREDENTIAL = /^popsql-\d+$/;
const CREDENTIALS_URL = (projectId) => `https://console.cloud.tigerdata.com/projects/${projectId}/settings`;

// The table's rows, or null when the sweep could not see the project. Waits for the first row
// (they paint ~3s after domcontentloaded) rather than trusting a fixed sleep: an instantaneous read
// on an unpainted table reported "removed" for a row that was still there.
async function loadCredentials(page, projectId) {
  const url = CREDENTIALS_URL(projectId);
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 }).catch(() => {});
  await page.waitForTimeout(2000);
  if (landsOnLogin(page)) {
    await signIn(page).catch(() => {});
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 }).catch(() => {});
    await page.waitForTimeout(2000);
  }
  if (landsOnLogin(page)) return null;
  await page.getByRole("button", { name: "Create credentials" }).waitFor({ timeout: 20000 }).catch(() => {});
  await page.locator(ROW).first().waitFor({ timeout: 10000 }).catch(() => {}); // an empty table has none
  const settled = await settledRows(page);
  const rows = [];
  for (const r of settled.rows) {
    const cell = async (k) => ((await r.row.locator(`[data-cy$="-cell-${k}"]`).first().innerText().catch(() => "")) || "").replace(/\s+/g, " ").trim();
    rows.push({ row: r.row, name: await cell("credential-name"), publicKey: await cell("publicKey"), issuedBy: await cell("issuingUser"), created: await cell("dateCreated") });
  }
  return rows;
}

const strip = ({ row, ...rest }) => rest;

/** The table before a run: what sweepCredentials later measures "new" against. */
export async function listCredentials(page, projectId) {
  const rows = await loadCredentials(page, projectId);
  return rows ? rows.map(strip) : null;
}

export async function sweepCredentials(page, projectId, { baseline = null, ownedNames = [], dryRun = false } = {}) {
  const { email } = consoleCredentials();
  const known = new Set((baseline || []).map((r) => r.publicKey));
  const out = [];
  let rows = await loadCredentials(page, projectId);
  if (!rows) return [{ name: "-", state: "redirected to the login page — the sweep could not see the project" }];
  const seen = new Set();
  for (let guard = 0; guard < 20 && rows; guard++) {
    const next = rows.find((r) => r.publicKey && !seen.has(r.publicKey));
    if (!next) break;
    seen.add(next.publicKey);
    if (!next.issuedBy.toLowerCase().includes(email.toLowerCase())) continue; // someone else's: the project has real people in it
    if (CONSOLE_MANAGED_CREDENTIAL.test(next.name)) continue;
    const owned = ownedNames.includes(next.name) || (baseline && !known.has(next.publicKey));
    if (!owned) { out.push({ name: next.name, state: `issued by this account before the run — left in place (created ${next.created})` }); continue; }
    if (dryRun) { out.push({ name: next.name, state: `would remove (created ${next.created})` }); continue; }
    try {
      const outcome = await deleteRow(page, next.row, false);
      if (outcome.skipped) { out.push({ name: next.name, state: outcome.skipped }); continue; }
      rows = await loadCredentials(page, projectId); // verify from a fresh load, never from the click
      const left = (rows || []).some((r) => r.publicKey === next.publicKey);
      out.push({ name: next.name, state: left ? "removal did not take — left in place" : "removed" });
    } catch (e) {
      await page.keyboard.press("Escape").catch(() => {});
      out.push({ name: next.name, state: `error: ${(e.message || "").split("\n")[0]}` });
      rows = await loadCredentials(page, projectId);
    }
  }
  return out;
}
