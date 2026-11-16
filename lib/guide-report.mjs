// How a guide-command finding (lib/fidelity.mjs guideCommandDrift) reads to the person who has to act
// on it. One place, because `lint-plan` and `test-page` print the same findings and must agree.

const clip = (s) => String(s).replace(/\n/g, " ⏎ ").slice(0, 110);

const FIX = {
  "tab not on page": "the page no longer has that tab; fix OS_TABS or PATHS in lib/plan.mjs, or the page, so the plan has a reader's path to be checked against",
  "guide command not run": "run it in the plan, or declare `skip \\`<command>\\`: <reason>` if no run can take it",
  "command not on page": "the page does not give this command: copy the page's, or fix the page if the plan is the correct one",
  "command in an untagged fence": "the page gives this command in a code fence not tagged as shell (no tag, or one such as `yaml`), which the lint cannot read: tag the fence `bash` on the page (docs/adr/0011)",
  "heredoc never ends as shown": "a reader who pastes the page's fence gets a heredoc that never ends, though the plan's own copy would: put the terminator in column 0 on the page (or use `<<-` with tabs), docs/adr/0011",
  "wait names a container not on the page": "the page does not use that container name, so the wait would be on nothing a reader runs: copy the name from the page's `docker run`, or fix the page if the plan is right",
  "wait names a pod not on the page": "the page does not use that pod's StatefulSet name, so the wait would be on nothing a reader runs: copy the name from the page's StatefulSet (the pod is `<name>-0`), or fix the page if the plan is right",
  "asserts text the page never shows": "the text is not in any non-shell code fence on the reader's path, so the check is not tied to anything the page promises: use text from the page's sample output, or fix the page",
  "asserts text the plan itself types": "the terminal echoes what the plan types, so this check would pass without the guide's outcome: assert on text the command prints and the plan does not type",
  "command changed": "copy the page's command exactly, or fix the page if the plan is the correct one",
  "out of page order": "keep the page's order, so a reader and the run see the same sequence",
  "stale skip": "delete the skip, or put the command back in the plan",
};

// -> { kind, step?, detail, fix } in the shape lint-plan prints; `stepOf` numbers a step the way the
// page's other findings do.
export function describeGuideDrift(d, block, stepOf = (b, n) => n) {
  const kind = `guide: ${d.kind}`;
  const step = d.step ? stepOf(block.index, d.step) : undefined;
  let detail;
  if (d.kind === "tab not on page") detail = `block ${block.index}: no tab labelled \`${d.label}\``;
  else if (d.kind === "command changed") detail = `plan: ${clip(d.plan)}\n        page: ${clip(d.guide)}`;
  else if (d.kind === "guide command not run") detail = `block ${block.index} (${[block.os, block.path].filter(Boolean).join(", ")}): ${clip(d.guide)}`;
  else detail = `${clip(d.plan)}${d.detail ? ` (${d.detail})` : ""}`;
  return { kind, step, detail, fix: FIX[d.kind] };
}

// The advisory for a command in an untagged fence that the plan does not run: not required of a plan,
// but invisible to the lint, so it is listed (docs/adr/0011).
export function describeUntagged(u, block) {
  return { kind: "guide: untagged fence", advisory: true, step: undefined, detail: `block ${block.index} (${[block.os, block.path].filter(Boolean).join(", ")}): ${clip(u.guide)}`, fix: FIX["command in an untagged fence"] };
}
