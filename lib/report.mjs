// Build the human-readable report: a console summary printed in the terminal and a
// shareable screenshots/report.html with a PASS/FAIL verdict, the per-step log, and every
// screenshot inline. Screenshots are matched to each step by file-name base.

import { readdirSync, readFileSync, writeFileSync, existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { SHOTS } from "./walk.mjs";

const VERDICT = {
  pass: { label: "PASS", glyph: "✓", color: "#1a7f37" },
  fail: { label: "FAIL", glyph: "✗", color: "#cf222e" },
  stopped: { label: "STOPPED EARLY", glyph: "🛑", color: "#9a6700" },
  blocked: { label: "NEEDS INPUT", glyph: "⚠", color: "#9a6700" },
  manual: { label: "MANUAL", glyph: "◐", color: "#57606a" },
  skipped: { label: "NOT TESTABLE", glyph: "—", color: "#57606a" },
};
const STATUS = { ok: "✓", fail: "✗", stopped: "🛑", blocked: "⚠", manual: "◐", skipped: "—" };

// One line per product, from result.targets (docs/adr/0006). A product that did not run says so in
// words: "not run" is a --products choice, "not covered" is a page tag no block targets. Neither is
// folded into the page verdict, and neither is hidden behind it.
// A product whose block has no steps is "nothing to test", not NOT TESTABLE: the author looked and
// found no procedure, which is a different statement from "could not be tested".
const TARGET_WORDS = { "not run": "not run (--products / --os)", "not covered": "not covered by any <TestPlan> block", skipped: "nothing to test" };
const targetLine = (t) => `${t.target}${t.os ? ` (${[t.os, t.path].filter(Boolean).join(", ")})` : ""}${t.provided?.length ? ` [provided: ${t.provided.map((p) => p.version).join(", ")}]` : ""}: ${TARGET_WORDS[t.verdict] || VERDICT[t.verdict]?.label || t.verdict}`;

// Files for a step base: <base>-light.png, <base>-dark.png, and tiled <base>-light-2.png etc.
// Ordered light-then-dark, each in tile order (base image first, then -1, -2 …) — readdir's
// default sort would otherwise interleave them and put "-dark-1" before "-dark".
function shotFiles(base) {
  if (!existsSync(SHOTS)) return [];
  const re = new RegExp(`^${base.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}-(light|dark)(?:-(\\d+))?\\.png$`);
  return readdirSync(SHOTS)
    .map((f) => [f, re.exec(f)])
    .filter(([, m]) => m)
    .sort(([, a], [, b]) => (a[1] === b[1] ? 0 : a[1] === "light" ? -1 : 1) || (Number(a[2] || 0) - Number(b[2] || 0)))
    .map(([f]) => f);
}

// Quotes too: esc() feeds href="…" attributes, where a quote in a page URL or an artifact name
// would end the attribute (CodeQL js/incomplete-html-attribute-sanitization).
function esc(s) {
  return String(s).replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]
  );
}


// A cascade is one cause reported many times. When step 56 clicked the wrong control, the 13
// steps after it each reported "no control labelled X on the page" — thirteen findings, one bug, and
// the real one buried at the top. A single undocumented dialog has produced 7 failures in 4
// different shapes. Collapsing is presentational only: nothing is dropped from the HTML table or from
// the verdict, and the first failure in a run of them is always printed in full.
//
// Signature = the failure's shape with its specifics removed, so "no control labelled `Continue`" and
// "no control labelled `Close`" collapse together while a genuinely different failure does not.
// Built from the ERROR when there is one: the `did` line names the specific control ("click Close"),
// while the error names the SHAPE ("no control labelled `…` on the page"), and the shape is what a
// cascade shares. Signing on `did` alone collapsed nothing on the very cascade this exists for.
const signature = (a) =>
  a.status !== "fail"
    ? null
    : String(a.error || a.did)
        .replace(/`[^`]*`/g, "`…`")
        .replace(/"[^"]*"/g, '"…"')
        .replace(/\b\d+\b/g, "N")
        .trim();

export function collapseCascades(actions) {
  const out = [];
  let run = [];
  const flush = () => {
    if (!run.length) return;
    // Two of the same shape is not yet a cascade; three is.
    if (run.length >= 3) {
      out.push(run[0]);
      out.push({ ...run[1], error: undefined, collapsed: run.length - 1, did: `${run.length - 1} more step(s) failed the same way (steps ${run.slice(1).map((a) => a.step + 1).join(", ")}) — one cause, see step ${run[0].step + 1}` });
    } else out.push(...run);
    run = [];
  };
  for (const a of actions) {
    const sig = signature(a);
    if (sig && run.length && signature(run[0]) === sig) { run.push(a); continue; }
    flush();
    if (sig) run = [a]; else out.push(a);
  }
  flush();
  return out;
}

/**
 * The saved result of a run, but only one written at or after `since` (ms). test-page saves it once,
 * at the end, so a child that exits earlier (a plan refused before provisioning, a crash, the batch's
 * timeout kill) leaves the PREVIOUS run's file behind, and grading from that shows an old verdict as
 * this run's. Null when there is no file, it is unreadable, or it is older than `since`.
 */
export function savedRunSince(since, file = join(SHOTS, "last-run.json")) {
  try {
    if (statSync(file).mtimeMs < since) return null;
    return JSON.parse(readFileSync(file, "utf8"));
  } catch { return null; }
}

/**
 * One page's verdict from its run result. Exported because the batch runner needs to grade a run and
 * a second copy of this precedence would drift — the mutation gate proved that within an hour.
 */
export function overallVerdict(result) {
  return !result.testable
    ? "skipped"
    : result.procedures.some((p) => p.verdict === "fail")
    ? "fail"
    : result.procedures.some((p) => p.verdict === "blocked")
    ? "blocked"
    : result.procedures.some((p) => p.verdict === "stopped")
    ? "stopped"
    : "pass";
}

// page = { url, file, title, products }
// result = { testable, reason?, procedures: [{title, verdict, actions, shots, cleanup}], inputs: [names] }
export function buildReport(page, result) {
  const overall = overallVerdict(result);

  // ---- console summary
  const v = VERDICT[overall];
  console.log("\n" + "=".repeat(64));
  console.log(`  ${v.glyph}  ${v.label}  —  ${page.title || page.url}`);
  console.log("=".repeat(64));
  if (!result.testable) {
    console.log(`  Not tested: ${result.reason}`);
  } else {
    if (result.inputs?.length) console.log(`  Used inputs: ${result.inputs.join(", ")}`);
    if (result.targets?.length) console.log(`  Per product: ${result.targets.map(targetLine).join("; ")}`);
    if (result.fork) console.log(`  Destructive steps ran on a throwaway fork (${result.fork.id}), ${result.fork.deleted ? "deleted after the run" : "NOT deleted — check the Console"}.`);
    for (const proc of result.procedures) {
      const pv = VERDICT[proc.verdict];
      console.log(`\n  ${pv.glyph} ${pv.label} — ${proc.title}`);
      // Group by step and print the step's text once. A plan's steps are written out in full, so
      // this is the difference between "ran SQL" twenty times and a readable log.
      let lastStep = null;
      for (const a of collapseCascades(proc.actions)) {
        if (a.step !== lastStep && !a.collapsed) {
          const t = (proc.stepTitles || [])[a.step];
          if (t) console.log(`\n      step ${a.step + 1}: ${t.replace(/\s+/g, " ").slice(0, 150)}`);
          lastStep = a.step;
        }
        console.log(`        ${STATUS[a.status] || "?"} ${a.did}${a.error ? `  (${a.error})` : ""}`);
      }
      if (proc.cleanup) console.log(`      ${STATUS[proc.cleanup.status]} cleanup: ${proc.cleanup.did}`);
    }
    // What a pass does NOT cover. Without this a green report reads as "the page is fine", when the
    // plan may have deliberately left whole documented routes unscripted — and the reasons are
    // already written down in the plan.
    if (result.notes?.length) {
      console.log(`\n  What this run does NOT cover:`);
      for (const l of result.notes) console.log(`    ${l.replace(/^\s+/, "")}`);
    }
  }

  // ---- HTML report
  const procHtml = (result.procedures || []).map((proc) => {
    const pv = VERDICT[proc.verdict];
    let htmlLastStep = null;
    // Screenshots go INSIDE the log, in a row under the step they belong to, rather than in one
    // gallery after the table. With 71 images and 70 steps, a gallery means scrolling away from the
    // row you are reading to find its picture and counting captions to be sure you have the right
    // one, and mismatched step numbering is easy to misread.
    const shotsByStep = new Map();
    for (const sh of proc.shots || []) {
      const m = /-step(\d+)/.exec(sh.base);
      const key = m ? Number(m[1]) - 1 : null; // shot bases are 1-indexed, action.step is 0-indexed
      if (!shotsByStep.has(key)) shotsByStep.set(key, []);
      shotsByStep.get(key).push(sh);
    }
    const galleryFor = (list) =>
      (list || [])
        .map((sh) => {
          const imgs = shotFiles(sh.base)
            .map((f) => `<figure><img src="${f}"><figcaption>${esc(f.replace(/\.png$/, ""))}</figcaption></figure>`)
            .join("");
          return imgs ? `<div class="shotgroup"><h4>${esc(sh.caption)}</h4><div class="imgs">${imgs}</div></div>` : "";
        })
        .join("");

    const rowHtml = proc.actions.map((a) => {
      // A downloaded file is evidence a screenshot cannot show, so link the artifact from the row.
      // The link is to the REDACTED transcript (lib/walk.mjs's saveRedactedDownload) — the original is
      // a credentials file and is deliberately not kept.
      const art = a.artifact
        ? `<div class="art">artifact: <a href="downloads/${esc(a.artifact.redactedPath.split("/").pop())}">${esc(a.artifact.name)}</a>` +
          ` — ${a.artifact.bytes} bytes, sha256 ${esc(a.artifact.sha256.slice(0, 12))}` +
          (a.artifact.fields?.length ? `, fields: ${esc(a.artifact.fields.join(", "))}` : "") +
          ` <em>(values redacted)</em></div>`
        : "";
      // The step's own text, once per step rather than repeated on every action row.
      const first = a.step !== htmlLastStep;
      htmlLastStep = a.step;
      const title = first ? esc(((proc.stepTitles || [])[a.step] || "").replace(/\s+/g, " ")) : "";
      return `<tr${first ? ' class="firstofstep"' : ""}><td class="st">${STATUS[a.status] || "?"}</td><td>${first ? a.step + 1 : ""}</td><td class="stept">${title}</td><td>${esc(a.did)}${a.error ? `<div class="err">${esc(a.error)}</div>` : ""}${art}</td></tr>`;
    });

    // Emit each step's rows, then that step's screenshots, before moving to the next step.
    let rows = "";
    for (let n = 0; n < proc.actions.length; n++) {
      rows += rowHtml[n];
      const thisStep = proc.actions[n].step;
      const nextStep = proc.actions[n + 1]?.step;
      if (nextStep !== thisStep) {
        const g = galleryFor(shotsByStep.get(thisStep));
        if (g) rows += `<tr class="shotrow"><td></td><td></td><td></td><td>${g}</td></tr>`;
        shotsByStep.delete(thisStep);
      }
    }
    const cleanupRow = proc.cleanup
      ? `<tr><td class="st">${STATUS[proc.cleanup.status]}</td><td>—</td><td class="stept"></td><td>cleanup: ${esc(proc.cleanup.did)}</td></tr>`
      : "";
    // Anything left over: a shot whose step produced no action row at all, so there was nowhere to
    // put it inline. Shown after the table rather than dropped — an unexplained image is better than
    // a missing one.
    const gallery = [...shotsByStep.values()].map(galleryFor).join("");
    return `<section class="proc"><h2><span class="badge" style="background:${pv.color}">${pv.glyph} ${pv.label}</span> ${esc(proc.title)}</h2>
      <table class="log"><thead><tr><th></th><th>Step</th><th>What the plan says</th><th>What happened</th></tr></thead><tbody>${rows}${cleanupRow}</tbody></table>
      ${gallery}</section>`;
  }).join("");

  const notTestable = !result.testable
    ? `<p class="reason">This page was not tested: ${esc(result.reason)}</p>`
    : "";
  const inputsLine = result.inputs?.length
    ? `<p class="inputs">Inputs supplied at run time: ${result.inputs.map(esc).join(", ")} (values masked).</p>`
    : "";
  const targetsLine = result.targets?.length
    ? `<p class="inputs">Per product: ${result.targets.map((t) => esc(targetLine(t))).join("; ")}.</p>`
    : "";
  const forkLine = result.fork
    ? `<p class="inputs">Destructive steps ran on a throwaway fork <code>${esc(result.fork.id)}</code>, ${result.fork.deleted ? "deleted after the run." : "<strong>NOT deleted — check the Console.</strong>"}</p>`
    : "";

  const html = `<!doctype html><meta charset="utf-8"><title>Doc test report — ${esc(page.title || page.url)}</title>
<style>
  body{font:15px/1.5 -apple-system,system-ui,sans-serif;margin:0;background:#f6f8fa;color:#1f2328}
  header{background:#fff;border-bottom:1px solid #d0d7de;padding:24px 32px}
  .verdict{display:inline-block;font-weight:700;color:#fff;padding:4px 12px;border-radius:6px;background:${v.color}}
  h1{font-size:20px;margin:10px 0 4px} a{color:#0969da} .meta{color:#57606a;font-size:13px}
  main{padding:24px 32px;max-width:1100px}
  .proc{background:#fff;border:1px solid #d0d7de;border-radius:8px;padding:18px 22px;margin-bottom:22px}
  .proc h2{font-size:16px;display:flex;align-items:center;gap:10px;margin:0 0 14px}
  .badge{color:#fff;font-size:12px;padding:3px 9px;border-radius:20px}
  table.log{border-collapse:collapse;width:100%;margin-bottom:16px;font-size:13.5px}
  table.log th,table.log td{border-bottom:1px solid #eaeef2;padding:6px 8px;text-align:left;vertical-align:top}
  table.log .st{width:24px;font-size:15px} .err{color:#cf222e;font-size:12px;margin-top:3px}
  /* The plan's own wording, so a row says which step it belongs to rather than just "ran SQL". */
  table.log .stept{width:38%;color:#24292f;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px;white-space:pre-wrap;word-break:break-word}
  table.log tr.firstofstep td{border-top:1px solid #d0d7de}
  .art{color:#57606a;font-size:12px;margin-top:3px}
  .notes{background:#fff8c5;border:1px solid #d4a72c;border-radius:6px;padding:10px 14px;margin:16px 0}
  .notes h2{margin:0 0 6px;font-size:14px} .notes pre{margin:0;white-space:pre-wrap;font-size:12.5px;line-height:1.5}
  tr.shotrow td{background:#f6f8fa;border-top:0}
  .shotgroup{margin:12px 0} .shotgroup h4{margin:8px 0;font-size:13px;color:#57606a;font-weight:600}
  .imgs{display:flex;flex-wrap:wrap;gap:14px}
  figure{margin:0;max-width:360px} figure img{width:100%;border:1px solid #d0d7de;border-radius:6px;display:block;cursor:zoom-in}
  figcaption{font-size:11px;color:#8b949e;margin-top:4px;word-break:break-all}
  .reason{font-size:15px;color:#9a6700} .inputs{color:#57606a;font-size:13px}
  #lb{display:none;position:fixed;inset:0;background:rgba(0,0,0,.88);z-index:9999;cursor:zoom-out;align-items:center;justify-content:center;padding:24px}
  #lb.open{display:flex} #lb img{max-width:100%;max-height:100%;box-shadow:0 0 50px #000;border-radius:4px}
  #lb .hint{position:fixed;top:14px;right:18px;color:#bbb;font-size:12px}
</style>
<header>
  <span class="verdict">${v.glyph} ${v.label}</span>
  <h1>${esc(page.title || "Untitled page")}</h1>
  <div class="meta"><a href="${esc(page.url)}">${esc(page.url)}</a></div>
  <div class="meta">Source: ${esc(page.file || "")}${page.products?.length ? ` · products: ${esc(page.products.join(", "))}` : ""}</div>
</header>
<main>${notTestable}${targetsLine}${inputsLine}${forkLine}${procHtml}</main>
<div id="lb"><span class="hint">click anywhere or press Esc to close</span><img alt="expanded screenshot"></div>
<script>
  (function () {
    var lb = document.getElementById("lb"), big = lb.querySelector("img");
    document.addEventListener("click", function (e) {
      if (e.target.tagName === "IMG" && e.target.closest(".imgs")) { big.src = e.target.src; lb.classList.add("open"); }
      else if (lb.classList.contains("open")) { lb.classList.remove("open"); big.removeAttribute("src"); }
    });
    document.addEventListener("keydown", function (e) { if (e.key === "Escape") { lb.classList.remove("open"); big.removeAttribute("src"); } });
  })();
</script>`;

  const out = join(SHOTS, "report.html");
  writeFileSync(out, html);
  console.log(`\n  Full report: ${out}\n`);
  return { overall, out };
}