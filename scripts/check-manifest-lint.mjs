#!/usr/bin/env node
// Checks that a plan can carry a Kubernetes manifest and that the lint holds the page to what a reader
// pastes (docs/adr/0011). Against a small synthetic page, so it needs no docs checkout and no
// AWS. Every control that should go red is paired with the clean case it was mutated from: a lint that
// passes everything proves nothing.
//
// What the real page did, found by four runs on k3s: the PVC, StatefulSet and Service commands are in
// `yaml` fences the lint did not read, and the Deployment's closing `EOF` is indented, so the heredoc
// never ends for a reader. The plan's own copy of that command had a column-0 `EOF`, and the lint trimmed
// both, so the plan would have gone green over the bug.
import assert from "node:assert/strict";
import { parsePlan } from "../lib/plan.mjs";
import { guideCommandDrift, untaggedFences, logicalCommands } from "../lib/fidelity.mjs";

const F = "```";
let failed = 0;
async function check(name, fn) {
  try {
    await fn();
    console.log(`  ok    ${name}`);
  } catch (e) {
    failed++;
    console.log(`  FAIL  ${name}\n        ${String(e.message).split("\n").join("\n        ")}`);
  }
}

const SVC = ["apiVersion: v1", "kind: Service", "metadata:", "  name: demo", "spec:", "  ports:", "    - port: 5432"];
const pageOf = (fences) => `<Tabs>\n<TabItem label="Kubernetes">\n${fences}\n</TabItem>\n</Tabs>\n`;
const NS = `${F}shell\nkubectl create namespace tigerdata\n${F}`;
// the manifest command as a reader copies it, in a fence tagged `tag`, the fence itself opened at `open` columns
const applyFence = (tag, { open = 0, content = open, terminator = content, flag = "<<EOF" } = {}) => {
  const pad = (n) => " ".repeat(n);
  return [`${pad(open)}${F}${tag}`, `${pad(content)}kubectl apply -f - ${flag}`, ...SVC.map((l) => `${pad(content)}${l}`), `${pad(terminator)}EOF`, `${pad(open)}${F}`].join("\n");
};
const planOf = (mdx, steps) =>
  parsePlan(`${mdx}\n<TestPlan>\ntarget: self-hosted\nmachine: bare\nos: ubuntu\npath: kubernetes\n${steps.map((l, i) => `${i + 1}. ${l}`).join("\n")}\n</TestPlan>`).plans[0];
// the command as a plan writes it: the body indented under `run command:`
const APPLY_STEP = `run command:\n   \`kubectl apply -f - <<EOF\n${SVC.map((l) => `   ${l}`).join("\n")}\n   EOF\``;
const NS_STEP = "run command: `kubectl create namespace tigerdata`";
const kinds = (found) => found.map((f) => f.kind).sort();

console.log("a plan carries a manifest");

await check("a multi-line `run command:` keeps its body's relative indentation", () => {
  const block = planOf(pageOf(NS), [APPLY_STEP]);
  const run = block.steps.flatMap((s) => s.actions).find((a) => a.action === "run_shell");
  assert.equal(run.command, ["kubectl apply -f - <<EOF", ...SVC, "EOF"].join("\n"));
});

await check("a plan's `tee <<EOL` heredoc, indented as a whole, still reaches the box at column 0", () => {
  const block = planOf(pageOf(NS), ["run command:\n   `sudo tee /etc/x.list <<EOL\n   deb https://example.org main\n   EOL`"]);
  const run = block.steps.flatMap((s) => s.actions).find((a) => a.action === "run_shell");
  assert.equal(run.command, "sudo tee /etc/x.list <<EOL\ndeb https://example.org main\nEOL");
});

console.log("the lint compares a heredoc as the reader pastes it");

await check("a manifest in a shell fence, run as the page shows it, is clean", () => {
  const page = pageOf(`${NS}\n${applyFence("shell")}`);
  assert.deepEqual(guideCommandDrift(page, planOf(page, [NS_STEP, APPLY_STEP])), []);
});

await check("the same plan with the manifest flattened to column 0 is NOT clean (the mutation)", () => {
  const page = pageOf(`${NS}\n${applyFence("shell")}`);
  const flat = `run command:\n   \`kubectl apply -f - <<EOF\n${SVC.map((l) => `   ${l.trimStart()}`).join("\n")}\n   EOF\``;
  const found = guideCommandDrift(page, planOf(page, [NS_STEP, flat]));
  assert.ok(found.length > 0, "a flattened manifest is a different file and must not match the page");
});

await check("a page fence indented as a whole (opening at column 1, content at 1) is the same command", () => {
  const page = pageOf(`${NS}\n${applyFence("shell", { open: 1 })}`);
  assert.deepEqual(guideCommandDrift(page, planOf(page, [NS_STEP, APPLY_STEP])), []);
});

console.log("a command in a fence not tagged as shell");

await check("a `yaml` fence holding `kubectl apply` is listed, as an untagged one is", () => {
  const page = pageOf(`${NS}\n${applyFence("yaml")}`);
  const listed = untaggedFences(page, planOf(page, [NS_STEP]));
  assert.equal(listed.length, 1);
  assert.match(listed[0].guide, /^kubectl apply -f - <<EOF\napiVersion: v1\n/);
});

await check("a plan that runs it gets the specific finding, not `command not on page`", () => {
  const page = pageOf(`${NS}\n${applyFence("yaml")}`);
  assert.deepEqual(kinds(guideCommandDrift(page, planOf(page, [NS_STEP, APPLY_STEP]))), ["command in an untagged fence"]);
});

await check("tagging the same fence `shell` makes it an ordinary guide command (control)", () => {
  const page = pageOf(`${NS}\n${applyFence("shell")}`);
  assert.deepEqual(untaggedFences(page, planOf(page, [NS_STEP, APPLY_STEP])), []);
  assert.deepEqual(guideCommandDrift(page, planOf(page, [NS_STEP, APPLY_STEP])), []);
});

await check("a `yaml` fence that is only a manifest, with no command, is not reported", () => {
  const page = pageOf(`${NS}\n${F}yaml\n${SVC.join("\n")}\n${F}`);
  assert.deepEqual(untaggedFences(page, planOf(page, [NS_STEP])), []);
  assert.deepEqual(guideCommandDrift(page, planOf(page, [NS_STEP])), []);
});

await check("a `sql` fence is still sample input, never a command to report", () => {
  const page = pageOf(`${NS}\n${F}sql\nkubectl is not sql\n${F}`);
  assert.deepEqual(untaggedFences(page, planOf(page, [NS_STEP])), []);
});

console.log("a heredoc whose terminator is not at column 0");

const INDENTED = pageOf(`${NS}\n${applyFence("shell", { open: 0, content: 3, terminator: 3 })}`);

await check("an indented terminator is a finding, though the plan's own copy matches the page", () => {
  const found = guideCommandDrift(INDENTED, planOf(INDENTED, [NS_STEP, APPLY_STEP]));
  assert.deepEqual(kinds(found), ["heredoc never ends as shown"]);
  assert.match(found[0].plan, /EOF/);
});

await check("the same fence with the terminator at column 0 is clean (control)", () => {
  const page = pageOf(`${NS}\n${applyFence("shell", { open: 0, content: 3, terminator: 0 })}`);
  assert.deepEqual(guideCommandDrift(page, planOf(page, [NS_STEP, APPLY_STEP])), []);
});

await check("a terminator indented with the fence's own indent is fine: only what a reader pastes counts", () => {
  const page = pageOf(`${NS}\n${applyFence("shell", { open: 3 })}`);
  assert.deepEqual(guideCommandDrift(page, planOf(page, [NS_STEP, APPLY_STEP])), []);
});

await check("`<<-` with a tab-indented terminator is exempt: that is what `<<-` is for", () => {
  const body = ["kubectl apply -f - <<-EOF", ...SVC, "\tEOF"].join("\n");
  const page = pageOf(`${NS}\n${F}shell\n${body}\n${F}`);
  const step = `run command:\n   \`kubectl apply -f - <<-EOF\n${SVC.map((l) => `   ${l}`).join("\n")}\n   EOF\``;
  assert.ok(!kinds(guideCommandDrift(page, planOf(page, [NS_STEP, step]))).includes("heredoc never ends as shown"));
});

await check("a heredoc with no terminator at all is the same finding", () => {
  const body = ["kubectl apply -f - <<EOF", ...SVC].join("\n");
  const page = pageOf(`${NS}\n${F}shell\n${body}\n${F}`);
  assert.ok(kinds(guideCommandDrift(page, planOf(page, [NS_STEP]))).includes("heredoc never ends as shown"));
});

await check("the lint's own reading keeps relative indentation and stops at an indented terminator", () => {
  assert.deepEqual(logicalCommands(["a <<EOF", "x:", "  y: 1", "   EOF", "b"].join("\n")), ["a <<EOF\nx:\n  y: 1\nEOF", "b"]);
});

console.log(failed ? `\n${failed} check(s) failed` : "\nall checks passed");
process.exit(failed ? 1 : 0);
