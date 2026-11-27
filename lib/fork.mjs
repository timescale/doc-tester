// Fork-mode plumbing, via the Tiger CLI (NOT the Console UI). We drive fork/create/delete through
// `tiger`, and keep Playwright only for the documented UI walk we're actually testing. This removes
// all the Console-automation flakiness (hidden portal elements, cookie overlays, readiness detection,
// below-the-fold buttons) from the setup/teardown.
//
// Auth: the Tiger CLI moved to OAuth (`tiger auth login`, stored in the system keyring) — no more
// per-call TIGER_PUBLIC_KEY/SECRET_KEY needed. The ambient `tiger` session already resolves to
// whichever project it was logged into (confirmed live: `tiger service list` with no .env override
// returns the standing test service directly), so we just run `tiger` as-is and sanity-check the
// standing service is reachable before doing anything destructive, rather than silently trusting it.

import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { promisify } from "node:util";

const execFileP = promisify(execFile);

// The standing test services (one per cloud, both Enterprise plan) come from .env via
// lib/services.mjs, together with a hard list of services this tool must NEVER delete. Enterprise plan so plan-gated procedures (e.g. cross-region backup) can
// actually be forked and exercised, not just stopped-before. Both protected regardless of which
// one a given run is actively using (lib/walk.mjs's setCloud), so a bug picking the wrong base
// can never delete the OTHER cloud's standing service either.
import { STANDING_SERVICE_IDS } from "./services.mjs";
import { stopRequested } from "./stop.mjs";
export { STANDING_SERVICE_IDS };
// Read at each call: the ids are loaded by the entry point (lib/services.mjs requireCloud), after import.
const isProtected = (id) => Object.values(STANDING_SERVICE_IDS).includes(id);

// Sanity-check ONLY the service this run is about to fork. Checking every standing service
// meant an unreachable id for a cloud the page doesn't even use (a recreated or renamed
// service, say) aborted the fork for the cloud that WAS fine. That downgrade isn't loud: the
// run falls back to the standing service with every destructive step stopped-before, so a
// perfectly good page reports FAIL for reasons that have nothing to do with the docs.
const reachable = new Set();
export async function ensureReachable(id) {
  if (reachable.has(id)) return;
  try {
    await execFileP("tiger", ["service", "get", id, "--skip-update-check"], { timeout: 30_000 });
  } catch (e) {
    const detail = (e.stderr || e.message || "").toString().trim();
    // Name the likeliest cause first. Standing services get recreated under a new id, so a .env
    // value that was correct last month now points at nothing. Without this check the walk drives a
    // page it never reached and reports every service-scoped control as missing.
    throw new Error(
      `Service ${id} is not reachable — it has probably been deleted and recreated under a new id.\n` +
        `  Check:  tiger service list\n` +
        `  Then update DOCTEST_SERVICE_AWS / DOCTEST_SERVICE_AZURE in .env to the current ids.\n` +
        `  If the list is empty or errors, the CLI is logged into the wrong project: tiger auth login\n${detail}`
    );
  }
  reachable.add(id);
}

// Run a `tiger` command. Long default timeout (fork/delete wait for ready).
async function tiger(args, { timeout = 2_100_000 } = {}) {
  const { stdout } = await execFileP("tiger", [...args, "--skip-update-check"], {
    timeout,
    maxBuffer: 16 * 1024 * 1024,
  });
  return stdout;
}

async function tigerJson(args) {
  return JSON.parse(await tiger([...args, "-o", "json"]));
}

// What a run names the services it creates, so they can be told from everyone else's by name alone:
// the fork is `doctest-<page>`, a service the page's own steps create is `doctest-<page>-created`
// (`-2`, `-3` for the next ones). The run keeps the exact names it issued, and the end-of-run sweep
// deletes a service that appeared during the run only when it carries one of them; a service that
// appeared under any other name is somebody's, and is listed, never deleted (EDU-1068). Exact names,
// not a prefix: two pages can share a last path segment, and the project lock fails open.
export const runNamePrefix = (prefix) => `doctest-${prefix}`;
export const createdServiceName = (prefix, n) => `${runNamePrefix(prefix)}-created${n > 1 ? `-${n}` : ""}`;
export const ownedByRun = (service, names) => !!service?.name && [...names].includes(service.name);

// The services in `after` that are not in `before` (a Set of ids) and not in `exclude`, split into
// this run's own (one of the exact `names` it issued) and the others. Shared by the walk's capture of
// a service it just created and by the end-of-run sweep, so the two cannot disagree.
export function partitionArrivals(before, after, names, { exclude = [] } = {}) {
  const arrived = after.filter((s) => {
    const id = s.service_id || s.id;
    return id && !before.has(id) && !exclude.includes(id);
  });
  return { mine: arrived.filter((s) => ownedByRun(s, names)), others: arrived.filter((s) => !ownedByRun(s, names)) };
}

// `tiger service list -o json` — normalize to an array of service objects.
export async function listServices() {
  const out = await tigerJson(["service", "list"]).catch(() => []);
  return Array.isArray(out) ? out : out.services || [];
}

// Fork the base service into a throwaway copy. Returns { forkId, fork }. The CLI returns the new
// service's id directly and waits until it's ready, so there's no list-diff guessing.
// baseId defaults to AWS's standing service — callers forking for a specific page should pass
// STANDING_SERVICE_IDS[page.cloud] explicitly (see scripts/test-page.mjs) rather than rely on this.
export async function forkService(baseId = STANDING_SERVICE_IDS.aws, { name, snapshot = false } = {}) {
  await ensureReachable(baseId);
  const args = ["service", "fork", baseId, snapshot ? "--last-snapshot" : "--now", "--no-set-default", "--wait-timeout", "30m"];
  if (name) args.push("--name", name);
  const fork = await tigerJson(args);
  if (!fork?.service_id) throw new Error("fork did not return a service id");
  return { forkId: fork.service_id, fork };
}

// Poll until a service reports READY. A fork gets this for free (`service fork --wait-timeout`), but
// a service the DOCS create through the Console wizard has no CLI wait behind it — and SQL run against
// a still-provisioning service fails with connection errors that read exactly like documentation bugs.
export async function waitUntilReady(id, { timeoutMs = 15 * 60 * 1000, intervalMs = 15000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let status = null;
  // An interrupt ends the wait early: the caller keeps its previous target and the walk stops at its
  // next step (lib/stop.mjs). Not a throw, so the walk's own bookkeeping completes normally.
  while (Date.now() < deadline && !stopRequested()) {
    const j = await tigerJson(["service", "get", id]).catch(() => ({}));
    status = j.status || status;
    if (status === "READY") return { ok: true, status };
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return { ok: false, status };
}

// Credentials for a live connection come from the ENVIRONMENT, never from the docs. A page writes
// `psql -d "postgres://<username>:<password>@<host>:<port>/<database-name>"` and is right to: the
// reader has their own. The tool resolves the same thing from the CLI's keyring, which is why no
// connection string belongs in .env — a static one would go stale (the standing service ids changed
// twice today) and could never name the fork or page-created service that only exists mid-run.
//
// Never logged, never written to disk, never screenshotted: callers hold it in memory for the run.
export async function connectionString(id, { withPassword = true } = {}) {
  const args = ["db", "connection-string", id];
  if (withPassword) args.push("--with-password");
  const out = await tiger(args, { timeout: 60_000 }).catch(() => null);
  if (!out) return null;
  // The CLI prints the string alone, but take the last non-empty line to be safe about any notice.
  const line = out.split("\n").map((l) => l.trim()).filter(Boolean).pop();
  return line && /^postgres(?:ql)?:\/\//i.test(line) ? line : null;
}

// A service this RUN owns (a fork, or one a page's own procedure created) may have its password
// rotated so a connection is possible at all: a Console-created service shows its password once, on a
// screen the tool has already navigated past, and a fork's password is not in the keyring under the
// fork's id. Both are throwaways deleted at the end of the run, so rotating costs nothing.
//
// Deliberately gated on `owned`. The standing services are NOT rotated behind the user's back; when
// their password is missing the caller reports the step as skipped and says which command fixes it.
export async function ensureConnectionString(id, { owned = false } = {}) {
  const existing = await connectionString(id);
  if (existing) return existing;
  if (!owned) return null;
  const pw = randomBytes(32).toString("base64").replace(/[^A-Za-z0-9]/g, "").slice(0, 32);
  await tiger(["service", "update-password", id, "--new-password", pw], { timeout: 300_000 }).catch(() => {});
  await tiger(["db", "save-password", id, `--password=${pw}`], { timeout: 60_000 }).catch(() => {});
  return await connectionString(id);
}

// host:port, for docs that interpolate the endpoint rather than a whole connection string
// (strict-ssl's `psql "postgres://tsdbadmin@$SERVICE_URL_WITH_PORT/tsdb?sslmode=verify-full"`).
export async function serviceEndpoint(id) {
  const j = await tigerJson(["service", "get", id]).catch(() => null);
  if (!j) return null;
  const host = j.host || j.endpoint?.host;
  const port = j.port || j.endpoint?.port;
  return host && port ? { host, port, hostPort: `${host}:${port}` } : null;
}

// host:port of the service's connection POOLER, or null when it has none.
//
// `tiger service get` grows a `connection_pooler` object only once a pooler exists, so null here
// means "no pooler", not "lookup failed". Same host as the service, different port: verified live
// 2026-09-08 on a fork whose service answered on 35776 and whose pooler answered on 35322.
export async function poolerEndpoint(id) {
  const j = await tigerJson(["service", "get", id]).catch(() => null);
  const e = j?.connection_pooler?.endpoint;
  return e?.host && e?.port ? { host: e.host, port: e.port, hostPort: `${e.host}:${e.port}` } : null;
}

// What service is this one forked from? (null if it's a standalone service.)
export async function forkedFrom(id) {
  const j = await tigerJson(["service", "get", id]).catch(() => ({}));
  return j.forked_from?.service_id || null;
}

// Delete the read replica sets / standbys that were created on a fork. The CLI's `service list`
// hides standbys, so the caller supplies discoverChildren() (the Console list, which shows them);
// we only delete a candidate once we've confirmed via `service get` that it's forked from THIS fork.
async function deleteChildren(forkId, discoverChildren) {
  const candidates = (await discoverChildren()) || [];
  const children = [];
  for (const id of candidates) {
    if (id === forkId || isProtected(id) || !/^[a-z0-9]{10}$/.test(id)) continue;
    if ((await forkedFrom(id)) === forkId) children.push(id);
  }
  for (const c of children) await tiger(["service", "delete", c, "--confirm"]).catch(() => {});
  return children;
}

// `service delete` takes only `--confirm`: Tiger CLI 0.25.0 rejects `--wait-timeout` ("unknown
// flag"), which `service fork` does accept. Passing it here made every fork deletion fail with a
// bare "Command failed" and left the fork running, twice on 2026-09-23, while the run reported the
// leak correctly and nothing else was wrong.
//
// Delete a fork. Guardrails: must be a real id and never a protected service. If it has a read
// replica set, Tiger refuses ("cannot be deleted separately") — so delete the children first, retry.
// discoverChildren() (optional) returns candidate child IDs (e.g. the Console list incl. standbys);
// only those confirmed forked from this fork are removed. Returns true if gone; throws (naming the
// fork id) if it can't be removed, so the caller can surface it for manual cleanup.
export async function deleteService(forkId, { protectedIds = [], discoverChildren } = {}) {
  if (!/^[a-z0-9]{10}$/.test(forkId)) throw new Error(`refusing to delete: malformed id "${forkId}"`);
  if (isProtected(forkId) || protectedIds.includes(forkId)) throw new Error(`refusing to delete protected service ${forkId}`);
  try {
    await tiger(["service", "delete", forkId, "--confirm"]);
    return true;
  } catch (e) {
    const msg = (e.stderr || e.message || "").toString();
    if (!/cannot be deleted separately|replica|child|standby/i.test(msg)) throw e;
    if (!discoverChildren) throw new Error(`fork ${forkId} has a child resource and no way to discover it; delete manually: tiger service delete ${forkId} --confirm`);
    const removed = await deleteChildren(forkId, discoverChildren);
    if (!removed.length) throw new Error(`fork ${forkId} has a child resource that wasn't discovered; delete manually: tiger service delete ${forkId} --confirm`);
    await tiger(["service", "delete", forkId, "--confirm"]);
    return true;
  }
}