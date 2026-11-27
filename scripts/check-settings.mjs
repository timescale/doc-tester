#!/usr/bin/env node
// Checks lib/services.mjs: a setting is required by the code path that uses it, not on import, so the
// offline checks and the lint run with no configuration, a Cloud-only setup never names the state
// bucket, and a self-hosted-only setup never names a Cloud service (EDU-1070). Every case runs in a
// child process with the four variables set to EMPTY, which wins over the repo's .env (a variable
// already in the environment is not overwritten by loadEnvFile), so the result does not depend on
// whether this machine has a .env. No aws, no tiger: a throw must come before either is called.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

let failed = 0;
const check = (name, fn) => {
  try { fn(); console.log(`  ok   ${name}`); } catch (e) { failed++; console.log(`  FAIL ${name}\n       ${String(e.message).split("\n").join("\n       ")}`); }
};
const LIB = fileURLToPath(new URL("../lib/", import.meta.url));
const EMPTY = { DOCTEST_PROJECT_ID: "", DOCTEST_SERVICE_AWS: "", DOCTEST_SERVICE_AZURE: "", DOCTEST_TFSTATE_BUCKET: "" };
const run = (code, env = {}) => {
  const r = spawnSync(process.execPath, ["--input-type=module", "-e", code], { encoding: "utf8", timeout: 30_000, env: { ...process.env, ...EMPTY, ...env } });
  return { code: r.status, out: r.stdout + r.stderr };
};
const imp = (m) => `import * as m from ${JSON.stringify(LIB + m)};`;

console.log("with no configuration");
for (const m of ["walk.mjs", "fork.mjs", "slot.mjs", "lock.mjs", "ec2.mjs", "walk-ec2.mjs"]) {
  check(`${m} imports cleanly`, () => {
    const r = run(`${imp(m)} console.log("imported");`);
    assert.equal(r.code, 0, `${m}: ${r.out.slice(-400)}`);
    assert.match(r.out, /imported/, m);
  });
}
check("a report string on a self-hosted-only run keeps its nulls, and an empty one stays empty: no project loaded, nothing is masked as [project]", () => {
  const r = run(`${imp("walk.mjs")} console.log(m.scrubSecrets('ERROR: null value in column "t" violates not-null constraint; {"value": null}')); console.log("<" + m.scrubSecrets("") + ">");`);
  assert.match(r.out, /ERROR: null value in column "t" violates not-null constraint; \{"value": null\}/, r.out);
  assert.match(r.out, /^<>$/m, r.out);
});
check("a self-hosted run with no state bucket is refused by name before anything is provisioned", () => {
  const r = run(`${imp("services.mjs")} try { m.requireAws(); } catch (e) { console.log("refused: " + e.message); }`, { DOCTEST_PROJECT_ID: "p", DOCTEST_SERVICE_AWS: "a", DOCTEST_SERVICE_AZURE: "z" });
  assert.match(r.out, /refused: DOCTEST_TFSTATE_BUCKET is not set — a self-hosted run needs/);
});
check("a Cloud run is refused by name, all missing variables at once, before anything runs", () => {
  const r = run(`${imp("services.mjs")} try { m.requireCloud(); console.log("loaded"); } catch (e) { console.log("refused: " + e.message); }`);
  assert.match(r.out, /refused: DOCTEST_PROJECT_ID, DOCTEST_SERVICE_AWS, DOCTEST_SERVICE_AZURE are not set — a Tiger Cloud run needs/);
  assert.doesNotMatch(r.out, /loaded/);
});
check("…and names only what is missing", () => {
  const r = run(`${imp("services.mjs")} try { m.requireCloud(); } catch (e) { console.log("refused: " + e.message); }`, { DOCTEST_PROJECT_ID: "p1", DOCTEST_SERVICE_AWS: "a1" });
  assert.match(r.out, /refused: DOCTEST_SERVICE_AZURE is not set/);
});
check("the slot's first S3 call is refused by name, before aws is called", () => {
  const r = run(`${imp("slot.mjs")} const t0 = Date.now(); try { await m.read(); console.log("read"); } catch (e) { console.log("refused: " + e.message + " after " + (Date.now() - t0) + "ms"); }`);
  assert.match(r.out, /refused: DOCTEST_TFSTATE_BUCKET is not set — a self-hosted run needs the Terraform state bucket/);
  assert.match(r.out, /after (\d|[1-9]\d|[1-4]\d\d)ms/, "took long enough to have called aws: " + r.out);
});

console.log("with the settings");
const SET = { DOCTEST_PROJECT_ID: "proj000001", DOCTEST_SERVICE_AWS: "awsaws0001", DOCTEST_SERVICE_AZURE: "azure00001", DOCTEST_TFSTATE_BUCKET: "bucket-1" };
check("requireCloud loads them, every importer sees them, and setCloud picks the cloud's service", () => {
  const r = run(`${imp("services.mjs")} import * as w from ${JSON.stringify(LIB + "walk.mjs")}; import * as f from ${JSON.stringify(LIB + "fork.mjs")};
    console.log("before:", w.SERVICE_ID, f.STANDING_SERVICE_IDS.aws);
    const s = m.requireCloud(); w.setCloud("azure");
    console.log("after:", s.projectId, w.SERVICE_ID, f.STANDING_SERVICE_IDS.aws, w.PROJECT_ID);`, SET);
  assert.match(r.out, /before: null null/);
  assert.match(r.out, /after: proj000001 azure00001 awsaws0001 proj000001/);
});
check("a standing service is protected from deletion once loaded", () => {
  const r = run(`${imp("services.mjs")} import * as f from ${JSON.stringify(LIB + "fork.mjs")}; m.requireCloud(); try { await f.deleteService("awsaws0001"); } catch (e) { console.log("refused: " + e.message); }`, SET);
  assert.match(r.out, /refused: refusing to delete protected service awsaws0001/);
});
check("requireAws loads the bucket", () => {
  const r = run(`${imp("services.mjs")} console.log(m.TFSTATE_BUCKET, m.requireAws().tfstateBucket, m.TFSTATE_BUCKET);`, SET);
  assert.match(r.out, /null bucket-1 bucket-1/);
});

console.log(failed ? `\n${failed} check(s) failed` : "\nall checks passed");
process.exit(failed ? 1 : 0);
