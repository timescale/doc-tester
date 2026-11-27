// One run per project at a time.
//
// Every run starts by clearing project-level state (credentials, invites, allow lists) so the page is
// graded against an empty project. Two runs in the same project therefore fight: the second one's
// reset deletes the credential the first one just created, and the first reports a docs failure that
// never happened. Nothing in the project marks a run in progress — a fork does, but only for pages
// that fork, and the project-level pages are exactly the ones that don't.
//
// So the marker is a row in a table on the AWS standing service. Every runner in a project already
// points at that service and already has SQL access to it through the CLI's keyring, and a row is
// the one thing the pre-run reset does not sweep. The row carries a heartbeat: a run that crashed or
// was killed stops updating it, and the next run treats a row older than STALE_MS as abandoned and
// takes the lock. Acquisition is serialised by an ACCESS EXCLUSIVE lock on the table, so two runs
// arriving in the same second cannot both see it empty.
//
// A lock host that cannot be reached FAILS CLOSED: the run is refused, naming the host and the
// `--unlocked` flag (EDU-1015). It used to warn and run anyway, which is the one way two runs can
// still collide: a paused standing service, a scheduled runner and a laptop, and the batch's report
// blames the page for an allow list the other run deleted. A refused run is loud and costs nothing;
// `--unlocked` is for the person who knows the host is down and that they are the only runner.
// The tool's rule that the standing services are never mutated stands for what plans do; one schema
// holding one row is the tool's own bookkeeping, like the fork it creates.

import { spawn } from "node:child_process";
import { hostname } from "node:os";
import { connectionString, STANDING_SERVICE_IDS } from "./fork.mjs";

const STALE_MS = Number(process.env.DOCTEST_LOCK_STALE_MS || 5 * 60 * 1000);
const HEARTBEAT_MS = Number(process.env.DOCTEST_LOCK_HEARTBEAT_MS || 60 * 1000);
const TABLE = "doctest.run_lock";

function q(s) {
  return `'${String(s).replace(/'/g, "''")}'`;
}

// One psql session, several -c statements, unaligned tuples only. Rejects on any failure so a lock
// that could not be taken is never mistaken for one that was.
function psql(conn, statements) {
  return new Promise((resolve, reject) => {
    const args = ["-X", "-q", "-At", "-v", "ON_ERROR_STOP=1", "-d", conn];
    for (const s of statements) args.push("-c", s);
    const child = spawn("psql", args, {
      env: { ...process.env, PGCONNECT_TIMEOUT: "20", PAGER: "cat", PSQL_PAGER: "cat" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("error", reject);
    child.on("close", (code) => (code === 0 ? resolve(out) : reject(new Error((err || out).trim().split("\n")[0] || `psql exited ${code}`))));
  });
}

// Take the project lock for this run, or find out who has it.
//
// Returns { acquired: true, release, holder } or { acquired: false, holder, page, since }. `holder`
// names the machine and process so the person who finds the lock taken knows whom to ask, and `page`
// says what they are testing. On an unreachable host returns { acquired: false, open: true, host,
// reason }, or with `allowUnlocked` { acquired: true, open: true } with no row behind it — see the
// header on failing closed.
export async function acquireRunLock({ page, allowUnlocked = false }) {
  const holder = `${hostname()}:${process.pid}`;
  const hostId = STANDING_SERVICE_IDS.aws;
  const unreachable = (reason) => ({ acquired: allowUnlocked, open: true, holder, host: hostId, reason });
  const conn = hostId ? await connectionString(hostId).catch(() => null) : null;
  if (!conn) return unreachable(hostId ? `no connection string for the lock host ${hostId}` : "no lock host: the Cloud settings are not loaded");

  const setup = [
    `CREATE SCHEMA IF NOT EXISTS doctest`,
    `CREATE TABLE IF NOT EXISTS ${TABLE} (holder text PRIMARY KEY, page text NOT NULL, acquired timestamptz NOT NULL DEFAULT now(), heartbeat timestamptz NOT NULL DEFAULT now())`,
  ];
  // One transaction: lock the table, drop abandoned rows, insert ours only if the table is then
  // empty. The SELECT after it reports whoever holds the lock now, which is either us or the run
  // we have to wait for.
  const take =
    `BEGIN; LOCK TABLE ${TABLE} IN ACCESS EXCLUSIVE MODE; ` +
    `DELETE FROM ${TABLE} WHERE heartbeat < now() - (${q(`${STALE_MS} milliseconds`)})::interval; ` +
    `INSERT INTO ${TABLE} (holder, page) SELECT ${q(holder)}, ${q(page)} WHERE NOT EXISTS (SELECT 1 FROM ${TABLE}); COMMIT;`;
  const show = `SELECT holder, page, to_char(acquired AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI') || 'Z' FROM ${TABLE} LIMIT 1`;

  let row;
  try {
    row = (await psql(conn, [...setup, take, show])).trim().split("\n").filter(Boolean).pop();
  } catch (e) {
    return unreachable(e.message);
  }
  const [who, what, since] = (row || "").split("|");
  if (who !== holder) return { acquired: false, holder: who, page: what, since };

  // Keep the row fresh while the run lives. unref'd so a finished run is not kept alive by its own
  // heartbeat; release() clears it anyway.
  const beat = setInterval(() => {
    psql(conn, [`UPDATE ${TABLE} SET heartbeat = now() WHERE holder = ${q(holder)}`]).catch(() => {});
  }, HEARTBEAT_MS);
  beat.unref();

  let released = false;
  const release = async () => {
    if (released) return;
    released = true;
    clearInterval(beat);
    await psql(conn, [`DELETE FROM ${TABLE} WHERE holder = ${q(holder)}`]).catch(() => {});
  };
  return { acquired: true, holder, release };
}
