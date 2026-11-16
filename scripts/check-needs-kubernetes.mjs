#!/usr/bin/env node
// Checks `needs: kubernetes` (docs/adr/0011, step 4b): the token, and what its installer and probe do,
// run here against fake `curl`, `k3s`, `sha256sum`, `install` and `mv` so each branch is exercised without
// a box. No AWS. The point of most checks is a negative: an installer that goes on after something failed
// would leave a box that looks provided and is not.
//
// What the installer provides is what four runs showed a reader needs: k3s, the UPSTREAM kubectl at the
// version k3s serves (k3s's own `kubectl` symlink ignored ~/.kube/config), and the kubeconfig in the
// default user's ~/.kube/config.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, chmodSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parsePlan, NEEDS } from "../lib/plan.mjs";
import { INSTALLERS, provide } from "../lib/prerequisites.mjs";

const plan = (hdr) => parsePlan(`<TestPlan>\n${hdr}\n1. run command: \`true\`\n</TestPlan>`).plans[0];
const errs = (p) => p.errors.map((e) => e.detail).join(" | ");
const BARE = "target: self-hosted\nmachine: bare";

let failed = 0;
const check = async (name, fn) => {
  try { await fn(); console.log(`  ok   ${name}`); } catch (e) { failed++; console.log(`  FAIL ${name}\n       ${String(e.message).split("\n").join("\n       ")}`); }
};

console.log("the token");
await check("`needs: kubernetes` parses on Ubuntu, and is refused on a distro with no installer", () => {
  assert.deepEqual(plan(`${BARE}\nos: ubuntu\nneeds: kubernetes`).errors, []);
  assert.deepEqual(plan(`${BARE}\nos: ubuntu\nneeds: kubernetes`).needs, ["kubernetes"]);
  assert.deepEqual(NEEDS.kubernetes, ["ubuntu"]);
  assert.match(errs(plan(`${BARE}\nos: debian\nneeds: kubernetes`)), /not provided on debian.*ubuntu/);
});
await check("it combines with the others, in the order written", () => {
  assert.deepEqual(plan(`${BARE}\nos: ubuntu\nneeds: docker, kubernetes, psql`).needs, ["docker", "kubernetes", "psql"]);
});

console.log("the installer against fakes");
const dir = mkdtempSync(join(tmpdir(), "check-needs-k8s-"));
const fake = (name, body) => { writeFileSync(join(dir, name), `#!/bin/bash\n${body}\n`); chmodSync(join(dir, name), 0o755); };
// Every call is logged. FAIL_K3S fails the installer's download, K3S_VERSION is what `k3s --version` prints,
// SHA_OK=0 fails the checksum, ARCH is dpkg's.
fake("curl", `echo "curl $*" >> "$FAKE_LOG"
out=""; for ((i=1;i<=$#;i++)); do [ "\${!i}" = -o ] || [ "\${!i}" = -fsSLo ] && { j=$((i+1)); out="\${!j}"; }; done
url=""; for a in "$@"; do case "$a" in http*) url="$a";; esac; done
case "$url" in
  *get.k3s.io*) [ -n "$FAIL_K3S" ] && exit 22; printf 'echo k3s-installer-ran >> "$FAKE_LOG"\\n' > "$out";;
  *kubectl.sha256) echo deadbeef > "$out";;
  *) echo binary > "$out";;
esac`);
fake("k3s", `case "$1" in
  --version) echo "k3s version $K3S_VERSION (abc123)"; echo "go version go1.25";;
  kubectl) echo "ip-1 Ready control-plane 1s v1";;
esac`);
fake("dpkg", `echo "\${ARCH:-amd64}"`);
fake("sha256sum", `echo "sha256sum $*" >> "$FAKE_LOG"; cat > /dev/null; [ "$SHA_OK" != 0 ]`);
fake("install", `echo "install $*" >> "$FAKE_LOG"`);
fake("mv", `echo "mv $*" >> "$FAKE_LOG"`);
fake("getent", `echo "ubuntu:x:1000:1000::/home/ubuntu:/bin/bash"`);

const install = (env = {}) => {
  const log = join(dir, `log-${Math.random().toString(36).slice(2)}`);
  writeFileSync(log, "");
  const r = spawnSync("bash", ["-c", INSTALLERS.kubernetes.ubuntu.install("ubuntu")], { env: { PATH: `${dir}:${process.env.PATH}`, FAKE_LOG: log, K3S_VERSION: "v1.36.5+k3s1", SHA_OK: "1", ...env }, encoding: "utf8", timeout: 20_000 });
  const calls = readFileSync(log, "utf8").trim().split("\n").filter(Boolean);
  return { code: r.status, err: r.stderr, calls, at: (re) => calls.findIndex((c) => re.test(c)) };
};

await check("control: k3s, then kubectl at the server's version with its checksum verified, then the user's kubeconfig, in that order", () => {
  const r = install();
  assert.equal(r.code, 0, r.err);
  const order = [/k3s-installer-ran/, /curl .*dl\.k8s\.io\/release\/v1\.36\.5\/bin\/linux\/amd64\/kubectl$/, /curl .*kubectl\.sha256$/, /sha256sum --check/, /mv -f \/usr\/local\/bin\/kubectl\.new \/usr\/local\/bin\/kubectl$/, /install .*-o ubuntu -g ubuntu -m 600 \/etc\/rancher\/k3s\/k3s\.yaml \/home\/ubuntu\/\.kube\/config$/].map((re) => r.at(re));
  assert.ok(order.every((i) => i >= 0), `a step is missing: ${order.join(",")}\n${r.calls.join("\n")}`);
  assert.deepEqual([...order].sort((a, b) => a - b), order, "steps ran out of order");
});
await check("the version is the server's with the `+k3s1` suffix dropped, because kubectl is published without it", () => {
  const r = install({ K3S_VERSION: "v1.31.2+k3s2" });
  assert.ok(r.at(/dl\.k8s\.io\/release\/v1\.31\.2\/bin/) >= 0, r.calls.join("\n"));
});
await check("the architecture is the box's, not a constant", () => {
  assert.ok(install({ ARCH: "arm64" }).at(/linux\/arm64\/kubectl$/) >= 0);
});
await check("the installer's download failing stops everything: no k3s install, no kubectl, no kubeconfig", () => {
  const r = install({ FAIL_K3S: "1" });
  assert.notEqual(r.code, 0);
  assert.equal(r.at(/k3s-installer-ran/), -1);
  assert.equal(r.at(/dl\.k8s\.io/), -1);
  assert.equal(r.at(/^mv /), -1);
});
await check("a `k3s --version` that cannot be read stops before any kubectl is downloaded", () => {
  const r = install({ K3S_VERSION: "nonsense" });
  assert.notEqual(r.code, 0);
  assert.equal(r.at(/dl\.k8s\.io/), -1);
  assert.equal(r.at(/^mv /), -1);
});
await check("a checksum mismatch stops before kubectl replaces anything and before the kubeconfig is written", () => {
  const r = install({ SHA_OK: "0" });
  assert.notEqual(r.code, 0);
  assert.ok(r.at(/sha256sum --check/) >= 0, "the checksum was never checked");
  assert.equal(r.at(/^mv /), -1, "kubectl was replaced despite the mismatch");
  assert.equal(r.at(/\.kube\/config/), -1, "the kubeconfig was written despite the mismatch");
});
await check("kubectl replaces k3s's symlink by rename, never by writing through it", () => {
  const r = install();
  assert.ok(r.at(/install .* \/usr\/local\/bin\/kubectl\.new$/) >= 0 && r.at(/mv -f \/usr\/local\/bin\/kubectl\.new \/usr\/local\/bin\/kubectl$/) >= 0);
  assert.equal(r.at(/install .* \/usr\/local\/bin\/kubectl$/), -1, "installed straight onto /usr/local/bin/kubectl, which is k3s's symlink");
});

console.log("the probe, and how a probe is delivered");
const probe = (env) => spawnSync("bash", ["-c", INSTALLERS.kubernetes.ubuntu.probe], { env: { PATH: `${dir}:${process.env.PATH}`, ...env }, encoding: "utf8", timeout: 20_000 });
fake("kubectl", `case "$1" in
  wait) exit \${WAIT_RC:-0};;
  get) echo "v1.36.5+k3s1";;
  version) echo "Client Version: v1.36.5"; echo "Kustomize Version: v5.8.1";;
esac`);
await check("a Ready node prints both versions on one line", () => {
  const r = probe({});
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout.trim(), "k3s v1.36.5+k3s1, kubectl v1.36.5");
});
await check("a node that never becomes Ready fails the probe (the control for the one above)", () => {
  assert.notEqual(probe({ WAIT_RC: "1" }).status, 0);
});
await check("provide() delivers a probe as a script file and runs it as the default user, so `$(...)` is the box's, not the outer shell's", async () => {
  const sent = [];
  const send = async (id, command) => {
    sent.push(command);
    return { Status: "Success", StandardOutputContent: "k3s v1.36.5+k3s1, kubectl v1.36.5\n" };
  };
  const provided = await provide("i-fake", "ubuntu", ["kubernetes"], { log: () => {}, send });
  assert.deepEqual(provided, [{ need: "kubernetes", version: "k3s v1.36.5+k3s1, kubectl v1.36.5" }]);
  const probeCall = sent.find((c) => /sudo -u ubuntu -H bash /.test(c));
  assert.ok(probeCall, sent.join("\n---\n"));
  assert.doesNotMatch(probeCall, /bash -c/, "the probe went through `bash -c`, where its `$(...)` would be expanded by the outer shell");
});
await check("a probe that fails after a successful install is reported as installed but not usable, not as provided", async () => {
  let n = 0;
  const send = async () => (++n === 1 ? { Status: "Success" } : { Status: "Failed", StandardErrorContent: "node not Ready" });
  await assert.rejects(provide("i-fake", "ubuntu", ["kubernetes"], { log: () => {}, send }), /installed but not usable by ubuntu without sudo: node not Ready/);
});
await check("docker and psql are still provided the same way (control)", async () => {
  const send = async () => ({ Status: "Success", StandardOutputContent: "docker 29.9.1\n" });
  const provided = await provide("i-fake", "ubuntu", ["docker", "psql"], { log: () => {}, send });
  assert.deepEqual(provided.map((p) => p.need), ["docker", "psql"]);
});

console.log(failed ? `\n${failed} check(s) failed` : "\nall checks passed");
process.exit(failed ? 1 : 0);
