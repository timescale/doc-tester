#!/usr/bin/env node
// Checks that DOCTEST_AWS_PROFILE alone decides the AWS identity (EDU-1069): lib/aws-env.mjs for the
// tool's own calls, infra/env.sh for the scripts that run terraform, and no profile written into the
// Terraform files or into any other aws call. init.sh runs from a copy holding only the two scripts it
// needs, against a fake `terraform` on PATH that prints whether it saw AWS_PROFILE, so nothing touches
// AWS and nothing from this clone's infra/ (state cache, provider binaries) is copied anywhere.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { awsProfile, awsEnv } from "../lib/aws-env.mjs";

let failed = 0;
const check = (name, fn) => {
  try { fn(); console.log(`  ok   ${name}`); } catch (e) { failed++; console.log(`  FAIL ${name}\n       ${String(e.message).split("\n").join("\n       ")}`); }
};
const ROOT = fileURLToPath(new URL("..", import.meta.url));
const withEnv = (patch, fn) => {
  const saved = { DOCTEST_AWS_PROFILE: process.env.DOCTEST_AWS_PROFILE, AWS_PROFILE: process.env.AWS_PROFILE };
  for (const [k, v] of Object.entries(patch)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  try { return fn(); } finally { for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } }
};

console.log("the tool's own calls (lib/aws-env.mjs)");
check("unset: docs-tester, and an ambient AWS_PROFILE is overridden", () => withEnv({ DOCTEST_AWS_PROFILE: undefined, AWS_PROFILE: "somebody-else" }, () => {
  assert.equal(awsProfile(), "docs-tester");
  assert.equal(awsEnv().AWS_PROFILE, "docs-tester");
}));
check("set: that profile, as written", () => withEnv({ DOCTEST_AWS_PROFILE: "mine" }, () => {
  assert.equal(awsProfile(), "mine");
  assert.equal(awsEnv({ X: "1" }).AWS_PROFILE, "mine");
  assert.equal(awsEnv({ X: "1" }).X, "1");
}));
check("empty: no profile at all, and an ambient AWS_PROFILE is removed from the child's environment", () => withEnv({ DOCTEST_AWS_PROFILE: "", AWS_PROFILE: "somebody-else" }, () => {
  assert.equal(awsProfile(), "");
  assert.equal("AWS_PROFILE" in awsEnv(), false);
}));

console.log("the infra scripts (infra/env.sh)");
const tmp = mkdtempSync(join(tmpdir(), "check-aws-profile-"));
try {
  // A fake terraform that reports AWS_PROFILE; init.sh calls `terraform init` and nothing else.
  const bin = join(tmp, "bin");
  mkdirSync(bin);
  writeFileSync(join(bin, "terraform"), `#!/bin/sh\nif [ "\${AWS_PROFILE+set}" = set ]; then echo "AWS_PROFILE=$AWS_PROFILE"; else echo "AWS_PROFILE unset"; fi\ncase " $* " in *" -reconfigure "*) echo "reconfigure" ;; esac\nif [ "\${AWS_DEFAULT_PROFILE+set}" = set ]; then echo "AWS_DEFAULT_PROFILE=$AWS_DEFAULT_PROFILE"; fi\n`);
  chmodSync(join(bin, "terraform"), 0o755);
  // Only the two scripts, in a copy with no ../.env beside it unless a case writes one.
  const copy = join(tmp, "repo", "infra");
  mkdirSync(copy, { recursive: true });
  for (const f of ["init.sh", "env.sh"]) copyFileSync(join(ROOT, "infra", f), join(copy, f));
  const dotenv = join(tmp, "repo", ".env");
  const init = (env, envFile = null) => {
    if (envFile === null) rmSync(dotenv, { force: true }); else writeFileSync(dotenv, envFile);
    const r = spawnSync("bash", [join(copy, "init.sh")], { encoding: "utf8", env: { PATH: `${bin}:${process.env.PATH}`, HOME: process.env.HOME, DOCTEST_TFSTATE_BUCKET: "b", ...env } });
    return (r.stdout + r.stderr).trim();
  };
  check("unset: terraform runs as docs-tester, whatever AWS_PROFILE the shell had", () => assert.equal(init({ AWS_PROFILE: "somebody-else" }), "AWS_PROFILE=docs-tester"));
  check("set: terraform runs as that profile", () => assert.equal(init({ DOCTEST_AWS_PROFILE: "mine" }), "AWS_PROFILE=mine"));
  check("empty: terraform sees no AWS_PROFILE at all, even when the shell had one", () => assert.equal(init({ DOCTEST_AWS_PROFILE: "", AWS_PROFILE: "somebody-else" }), "AWS_PROFILE unset"));
  check(".env: a profile line is read, quotes and comments included, and an empty line means none", () => {
    assert.equal(init({}, '# comment\nDOCTEST_AWS_PROFILE="from-file"\nOTHER=x\n'), "AWS_PROFILE=from-file");
    assert.equal(init({}, "DOCTEST_AWS_PROFILE=\n"), "AWS_PROFILE unset");
    assert.equal(init({}, "OTHER=x\n"), "AWS_PROFILE=docs-tester");
  });
  check(".env: a variable already in the environment wins over the file, as in the tool (lib/services.mjs)", () => {
    assert.equal(init({ DOCTEST_AWS_PROFILE: "" }, "DOCTEST_AWS_PROFILE=from-file\n"), "AWS_PROFILE unset");
    assert.equal(init({ DOCTEST_AWS_PROFILE: "shell" }, "DOCTEST_AWS_PROFILE=from-file\n"), "AWS_PROFILE=shell");
  });
  check(".env: the shapes loadEnvFile reads the same way: trailing space, inline comment, CRLF, single quotes, export prefix", () => {
    assert.equal(init({}, "DOCTEST_AWS_PROFILE=mine   \n"), "AWS_PROFILE=mine");
    assert.equal(init({}, "DOCTEST_AWS_PROFILE=mine # the profile\n"), "AWS_PROFILE=mine");
    assert.equal(init({}, "DOCTEST_AWS_PROFILE=mine\r\n"), "AWS_PROFILE=mine");
    assert.equal(init({}, "DOCTEST_AWS_PROFILE='mine'\n"), "AWS_PROFILE=mine");
    assert.equal(init({}, "export DOCTEST_AWS_PROFILE=mine\n"), "AWS_PROFILE=mine");
    assert.equal(init({}, "  DOCTEST_AWS_PROFILE = mine\n"), "AWS_PROFILE=mine");
  });
  check(".env: a value is taken literally, never expanded or run, and a bad name is skipped rather than fatal", () => {
    assert.equal(init({}, "DOCTEST_AWS_PROFILE=$(echo pwned)`echo x`; echo y\n"), "AWS_PROFILE=$(echo pwned)`echo x`; echo y");
    assert.equal(init({}, "1BAD=x\nnot a line\nDOCTEST_AWS_PROFILE=mine\n"), "AWS_PROFILE=mine");
  });
  check("empty: AWS_DEFAULT_PROFILE is dropped too, so the aws CLI cannot fall back to it", () => {
    assert.equal(init({ DOCTEST_AWS_PROFILE: "", AWS_DEFAULT_PROFILE: "admin" }), "AWS_PROFILE unset");
    withEnv({ DOCTEST_AWS_PROFILE: "" }, () => { process.env.AWS_DEFAULT_PROFILE = "admin"; try { assert.equal("AWS_DEFAULT_PROFILE" in awsEnv(), false); } finally { delete process.env.AWS_DEFAULT_PROFILE; } });
  });
  check("init passes -reconfigure only when the cached backend block still carries a profile (the one-off rollover)", () => {
    assert.doesNotMatch(init({}), /reconfigure/);
    mkdirSync(join(copy, ".terraform"), { recursive: true });
    writeFileSync(join(copy, ".terraform", "terraform.tfstate"), JSON.stringify({ backend: { config: { bucket: "b", profile: "docs-tester" } } }));
    assert.match(init({}), /reconfigure/);
    // The rolled-over cache lists the key with a null value, which is not a profile.
    writeFileSync(join(copy, ".terraform", "terraform.tfstate"), JSON.stringify({ backend: { config: { bucket: "b", profile: null } } }, null, 2));
    assert.doesNotMatch(init({}), /reconfigure/);
  });
  check(".env: the bucket the backend needs is read from the file too", () => {
    const r = spawnSync("bash", [join(copy, "init.sh")], { encoding: "utf8", env: { PATH: `${bin}:${process.env.PATH}`, HOME: process.env.HOME } });
    assert.match(r.stdout + r.stderr, /set DOCTEST_TFSTATE_BUCKET/);
    writeFileSync(dotenv, "DOCTEST_TFSTATE_BUCKET=from-file\n");
    const r2 = spawnSync("bash", [join(copy, "init.sh")], { encoding: "utf8", env: { PATH: `${bin}:${process.env.PATH}`, HOME: process.env.HOME } });
    assert.equal((r2.stdout + r2.stderr).trim(), "AWS_PROFILE=docs-tester");
  });
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
check("a profile that does not exist is named in the error of the first aws call (the slot lease)", () => {
  const dir = mkdtempSync(join(tmpdir(), "check-aws-profile-"));
  try {
    // A fake aws that fails the way the real one does for an unknown profile.
    writeFileSync(join(dir, "aws"), `#!/bin/sh\necho "The config profile (\${AWS_PROFILE:-none}) could not be found" >&2\nexit 255\n`);
    chmodSync(join(dir, "aws"), 0o755);
    const slot = fileURLToPath(new URL("../lib/slot.mjs", import.meta.url));
    const r = spawnSync(process.execPath, ["--input-type=module", "-e", `import * as s from ${JSON.stringify(slot)}; try { await s.read(); console.log("read"); } catch (e) { console.log("failed: " + e.message); }`], {
      encoding: "utf8", timeout: 30_000,
      env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, DOCTEST_AWS_PROFILE: "no-such-profile", DOCTEST_PROJECT_ID: "p", DOCTEST_SERVICE_AWS: "a", DOCTEST_SERVICE_AZURE: "z", DOCTEST_TFSTATE_BUCKET: "b" },
    });
    assert.match(r.stdout + r.stderr, /failed: aws s3api get-object: The config profile \(no-such-profile\) could not be found/, r.stdout + r.stderr);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
check("every infra script sources the one rule before anything else runs, and none sets a profile of its own", () => {
  for (const s of ["init.sh", "up.sh", "down.sh", "tunnel.sh"]) {
    const t = readFileSync(join(ROOT, "infra", s), "utf8").replace(/^#.*$/gm, "");
    const at = t.indexOf("source ./env.sh");
    assert.ok(at >= 0, `${s} does not source env.sh`);
    assert.doesNotMatch(t.slice(0, at), /\b(terraform|aws)\b/, `${s} runs something before env.sh`);
    assert.doesNotMatch(t, /AWS_PROFILE=|source "\$ENV_FILE"/, s);
  }
});
check("no Terraform file names a profile", () => {
  for (const f of readdirSync(join(ROOT, "infra")).filter((n) => n.endsWith(".tf"))) {
    const t = readFileSync(join(ROOT, "infra", f), "utf8").replace(/#.*$/gm, "");
    assert.doesNotMatch(t, /\bprofile\s*=/, f);
    assert.doesNotMatch(t, /aws_profile/, f);
  }
});
// A tripwire, not a proof: it matches the two shapes the old code had.
check("no aws call under lib/ or scripts/ names a profile or builds AWS_PROFILE on its own", () => {
  const own = new Set(["aws-env.mjs", "check-aws-profile.mjs"]);
  for (const dir of ["lib", "scripts"]) for (const f of readdirSync(join(ROOT, dir)).filter((n) => n.endsWith(".mjs") && !own.has(n))) {
    const t = readFileSync(join(ROOT, dir, f), "utf8").replace(/^\s*\/\/.*$/gm, "");
    assert.doesNotMatch(t, /"--profile"|AWS_PROFILE\s*:/, `${dir}/${f}`);
  }
});

console.log(failed ? `\n${failed} check(s) failed` : "\nall checks passed");
process.exit(failed ? 1 : 0);
