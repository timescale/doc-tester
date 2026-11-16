// Does the plan press the controls the PAGE names, in the places the page names?
//
// A plan is a bot-facing script of the same flow a reader follows, so the two must not diverge on
// WHERE they go or WHICH controls they press. A plan that clicks a control the page never names has
// either invented a path no customer would take — which makes its green meaningless — or is walking
// a flow the page no longer describes. Either way somebody needs to look.
//
// Confirmation dialogs are the one legitimate asymmetry, and they are excluded by GRAMMAR rather
// than by guesswork: a plan writes `confirm \`Let's go!\``, and confirm steps are skipped here. A
// reader looking at "You are about to enable tiered storage" can see the button and does not need
// telling, so the page is right not to mention it and the plan still needs the step.
//
// Position was tried as the discriminator instead — tolerate a divergent press that follows a
// page-named one — and it was abandoned because it excused almost everything: nearly every step in a
// plan follows a named press, so renaming `Invite new member` to `Add user` in a plan went unreported.
// Marking the confirm explicitly costs one word and catches those.
//
// The other reason an earlier version of this idea was deleted is worth recording: it graded EVERY
// step. `expect rows:` has no counterpart in prose, `go to /path` is positioning rather than a test,
// and `fork the service` is infrastructure, so grading those flagged every plan everywhere. Only
// steps that name a control a human presses are comparable — `click`, `toggle`, and the field of a
// `type ... into`.

import { stripSqlLineComments } from "./sql-text.mjs";
import { readFileSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { pathLabels, KEY_REPLY } from "./plan.mjs";

// Product names live in src/constants.ts and pages write `{C.SQL_EDITOR}` where a plan writes the
// literal "SQL editor". Without resolving these, every constant-bearing label reads as divergent —
// the `label={C.X}` blind spot that cost a previous session 28 actions.
function loadConstants(docsRepo) {
  try {
    const src = readFileSync(join(docsRepo, "src", "constants.ts"), "utf8");
    const C = {};
    for (const m of src.matchAll(/export const (\w+)\s*=\s*([`'"])([\s\S]*?)\2/g)) {
      C[m[1]] = m[3].replace(/\$\{(\w+)\}/g, (_, k) => C[k] ?? "");
    }
    return C;
  } catch {
    return null; // no constants file: compare literally rather than invent findings
  }
}

// The controls the PAGE names, as a set.
//
// Taken from the page's backticked spans rather than its full text, because house style puts UI
// element names in code font (the TigerData.UIElementsCodeFont rule enforces it), so the backticks
// ARE the page's control vocabulary. Matching against the whole prose instead is far too loose: a
// plan clicking `Delete` passed against the members page because the sentence "add and delete other
// users" contains the word, which is precisely the drift this check exists to catch.
//
// A page that names a control without code font produces a finding here. That is a style bug Vale
// also reports, so it is worth surfacing rather than absorbing.
function pageControls(mdx, C) {
  let prose = mdx.split("<TestPlan>")[0];
  if (C) prose = prose.replace(/\$?\{C\.(\w+)\}/g, (_, k) => C[k] ?? "");
  // Unwrap template-literal titles BEFORE pairing backticks. `title={\`… \\\`Members\\\` …\`}` is
  // delimited by backticks and escapes the ones around its controls, so naive pairing matches
  // delimiter-to-escape and captures "In Console, click " while `Members` falls BETWEEN pairs — every
  // control in a NumberedItem title read as absent from the page.
  prose = prose.replace(/title=\{`([\s\S]*?)`\}/g, (_, inner) => inner.replace(/\\`/g, "`"));
  prose = prose.replace(/\\`/g, "`");
  const set = new Set();
  for (const m of prose.matchAll(/`([^`\n]+)`/g)) set.add(m[1].trim().toLowerCase());
  return { set, text: prose.replace(/\s+/g, " ").toLowerCase() };
}

// Is this control named on the page?
//
// Code font is the primary answer. A MULTI-WORD label is also accepted when the page states it
// verbatim in prose, because a phrase like "Type the email" is unambiguous even unquoted and
// demanding backticks there produces a finding about house style rather than about drift.
//
// A single word gets no prose fallback, and that asymmetry is the point: `Delete` occurs inside "add
// and delete other users" on a page whose delete control is called `Remove`, so accepting bare words
// from prose is exactly how a wrong control passes. One-word controls must be in code font, which
// house style requires anyway.
function isNamed(label, controls) {
  const l = String(label).trim().toLowerCase();
  if (controls.set.has(l)) return true;
  return l.split(/\s+/).length > 1 && controls.text.includes(l);
}

// Which label, if any, this action claims a human presses and the page should therefore name.
// `confirm` is deliberately absent: it is the verb that says "this button is on a dialog", which is
// exactly the press a page is not expected to document.
function pressedLabel(a) {
  if (a.action === "click" || a.action === "toggle") return a.label || null;
  if (a.action === "type") return a.field || null;
  // A named drop-down is a control a reader is sent to, same as a typed field. The unnamed form
  // ("in the dropdown") names nothing and is not graded, as before.
  if (a.action === "select_other_option") return a.field || null;
  // `expect enabled` presses nothing, but it makes the same claim about the page's vocabulary: this
  // control exists and a reader is sent to it. It is how a destructive procedure gets tested up to
  // its last click, so the label it names is exactly the one that must not drift unnoticed.
  //
  // `expect label` is NOT graded, and the asymmetry is deliberate: it mostly asserts state the app
  // renders as text (`Meeting policy`, an invited address), which no page is expected to put in code
  // font, so grading it would flag every plan that checks a result.
  if (a.action === "expect_enabled") return a.label || null;
  return null;
}

/**
 * Controls a plan presses that the page never names.
 *
 * Returns [{ step, verb, label }]. Empty means the plan and the page agree on every control a reader
 * is sent to, which is the state a plan should be in before anyone trusts its result.
 */
export function controlsNotNamedOnPage(mdx, plan, docsRepo) {
  const controls = pageControls(mdx, loadConstants(docsRepo));
  const out = [];
  for (const [idx, step] of plan.steps.entries()) {
    const pressed = step.actions.map(pressedLabel).filter(Boolean);
    // `type $VAR into `Field`` is rewritten by parsePlan into a step-level testInput, so its action
    // is gone by the time we get here and only the step text still carries the field name. Without
    // this the field a plan types into was never compared at all.
    if (step.testInput) {
      const m = /\binto\s+`([^`]+)`/i.exec(step.text);
      if (m) pressed.push(m[1]);
    }
    for (const label of pressed) {
      if (!isNamed(label, controls)) out.push({ step: idx + 1, label });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Does the plan run the STATEMENTS the page prints?
// ---------------------------------------------------------------------------
//
// The control check above never sees SQL: `run SQL:` and `run command:` return null from
// pressedLabel, so every statement in every plan is retyped by hand and compared to nothing. A page
// whose SQL changes keeps its old plan passing, which is a green run testing something the page no
// longer says.
//
// This reports NEAR MISSES only, and that is the whole design. Three kinds of divergence are
// legitimate and must not be flagged:
//
//   - A placeholder filled in. House style writes `CREATE ROLE <ROLE_NAME>`, and a plan must name
//     something real because <ANGLE> placeholders do not substitute in a run SQL step. So a page
//     placeholder matches any run of non-space characters.
//   - A fixture the plan invents. Where the page's gap is a table the reader already owns, the
//     method tells the plan to create its own. That SQL resembles nothing on the page, so it scores
//     near zero and is ignored rather than reported as missing.
//   - An assertion. `expect rows:` has no counterpart in prose, the same reason the control check
//     grades no assertion.
//
// What is left is the case worth a person: a statement that is ALMOST a page block. That is either a
// retyping slip or a page that moved under its plan, and both need looking at.

// A shell continuation (backslash, newline) is how a page wraps a long command for the reader; the
// plan writes it on one line, and the two are the same command.
const normalize = (sql) =>
  String(sql).replace(/\\\s*\n/g, " ").replace(/\s+/g, " ").replace(/;\s*$/, "").trim().toLowerCase();

// For EQUALITY only, not for display. A page formats a statement for a reader and a plan writes it
// on one line, so the two differ by whitespace next to punctuation that collapsing runs does not
// reach: the page's `CREATE TABLE conditions (\n  time ...` normalizes to "( time" and the plan's to
// "(time". That spacing difference was reported as drift on quickstart-5-minutes and on two
// statements in tiger-cloud-essentials, all three scoring 1.0 -- identical words, unequal strings.
//
// Squeezing all whitespace also squeezes it inside string literals, so a page and plan that differ
// ONLY by spaces inside a quoted value compare equal. That is the right way to be wrong here: this
// check exists to surface near misses for a person, and a false positive on every multi-line
// statement in the corpus would bury the real ones.
const squeeze = (sql) => normalize(sql).replace(/\s+/g, "");

// A page statement becomes a pattern: placeholders match anything, everything else is literal.
// A shell variable the page tells the reader to export first (`-d "$SOURCE"`, on the self-hosted
// backup pages) is a placeholder of the same kind as `<db_name>`: the plan fills it with a literal,
// because every `run command:` on the EC2 target is its own shell and an export would not carry.
// An ellipsis is the page eliding part of a statement it has shown elsewhere (`CREATE MATERIALIZED
// VIEW … WITH (timescaledb.create_group_indexes=false) AS ...` on the continuous-aggregate index
// page); the plan has to write the whole statement, and that whole is what the elision stands for.
const PLACEHOLDER = /<[^>]*>|"?\$[A-Za-z_][A-Za-z0-9_]*"?|\.{3}|…/g;
const pageStatementToRegExp = (sql) => {
  const parts = squeeze(sql).split(PLACEHOLDER).map((lit) => lit.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  return new RegExp(`^${parts.join("\\S+")}$`);
};

// Word-set overlap. Cheap, order-insensitive, and good enough to separate "almost the same
// statement" from "an unrelated one", which is the only distinction this needs to make.
const similarity = (a, b) => {
  const wa = new Set(normalize(a).split(/[^a-z0-9_]+/).filter(Boolean));
  const wb = new Set(normalize(b).split(/[^a-z0-9_]+/).filter(Boolean));
  if (!wa.size || !wb.size) return 0;
  let shared = 0;
  for (const w of wa) if (wb.has(w)) shared++;
  return shared / new Set([...wa, ...wb]).size;
};

// A psql meta-command on its own line (`\c <db>` above `CREATE EXTENSION` on logical-backup) is not
// a statement and has no terminating semicolon, so left in it glues itself to the statement below.
// `\copy` is the exception: it is a command the reader runs and a plan runs it as `psql -c "\copy …"`,
// so it stays a statement. Dropping it read both COPY procedures on schema-then-data as empty and
// therefore uncoverable.
const META_LINE = /^[ \t]*\\(?!copy\b)[^\n]*\n?/gmi;

// Split a SQL body into statements on `;` at a line end, the way a page's fenced block and a plan's
// multi-line `run SQL:` step both mean it, EXCEPT inside a dollar-quoted string. A function body is
// one statement however many semicolons it holds: `CREATE FUNCTION … AS $$ BEGIN REINDEX TABLE
// mytable; END; $$ LANGUAGE plpgsql;` split blindly became three fragments, and the `BEGIN …`
// fragment of the custom-jobs page's syntax template was reported as a statement no plan runs
// (2026-10-12). A tag may be an identifier (`$body$`) or a placeholder the page uses as one
// (`$<variable_name>$`).
const DOLLAR_TAG = /^\$(?:[A-Za-z_][A-Za-z0-9_]*|<[^>\n]*>)?\$/;
export function splitSqlStatements(text) {
  const out = [];
  let buf = "";
  let tag = null;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === "$") {
      const m = text.slice(i).match(DOLLAR_TAG);
      if (m && (tag === null || m[0] === tag)) { tag = tag === null ? m[0] : null; buf += m[0]; i += m[0].length - 1; continue; }
    }
    if (ch === ";" && tag === null) {
      const rest = text.slice(i + 1).match(/^[ \t]*\r?\n/);
      if (rest) { out.push(buf); buf = ""; i += rest[0].length; continue; }
    }
    buf += ch;
  }
  out.push(buf);
  return out;
}

// A fenced block that prints a line which is nothing but a placeholder (`<declaration>;`,
// `<function_body>;`) is a syntax synopsis, not a statement a reader runs: no name can stand in for
// a whole statement, so no plan can fill it, and the runnable example is the block that follows.
// The custom-jobs page opens its procedure with one (2026-10-12).
const SYNOPSIS_LINE = /^[ \t]*<[^>\n]+>;?[ \t]*$/m;
const isSynopsis = (block) => SYNOPSIS_LINE.test(block);

// Fenced blocks the page prints, before the plan block. Output samples are fenced too and cannot be
// told apart reliably, so they stay in: an output block resembles no plan statement and scores near
// zero, which is the same reason plan-invented fixtures are safe.
function pageStatements(mdx) {
  const prose = mdx.split("<TestPlan>")[0];
  const out = [];
  for (const m of prose.matchAll(/```[a-z]*\n([\s\S]*?)```/g)) {
    if (isSynopsis(m[1])) continue;
    // Strip `--` comments the way the runner does before it inserts a statement: a comment is not
    // part of what runs, so it must not be part of what the plan is compared against either. Before
    // this, every commented block on a page (pg_textsearch has nine) read as drift.
    for (const part of splitSqlStatements(stripSqlLineComments(m[1]).replace(META_LINE, ""))) if (part.trim()) out.push(part.trim());
  }
  return out;
}

/**
 * Plan statements that are ALMOST, but not exactly, a statement the page prints.
 *
 * Returns [{ step, statement, closest, score }]. Empty means every statement the plan runs either
 * matches a page block (allowing for filled placeholders) or resembles none of them closely enough
 * to be a drifted copy of one.
 */
// An inline statement is run when a plan statement CONTAINS it: the page says `SET LOCAL` and the
// plan runs the whole `SET LOCAL timescaledb.skip_cagg_invalidation = on`. A quoted placeholder
// (`'<chunk_name>'`) is one gap, quotes included, so a plan may pass a variable where the page
// shows a quoted name.
const INLINE_PLACEHOLDER = /'<[^>]*>'|<[^>]*>|"?\$[A-Za-z_][A-Za-z0-9_]*"?/g;
export const inlineStatementToRegExp = (sql) => {
  const parts = squeeze(sql).split(INLINE_PLACEHOLDER).map((lit) => lit.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  return new RegExp(parts.join("\\S+"), "i");
};

// Inline code the page prints in its prose, long enough to be a clause rather than a name:
// "To skip duplicate rows, set `ON CONFLICT (time, location) DO NOTHING`" (upsert). A plan
// statement that carries such a span verbatim is running a variant the page itself spells out,
// not drifting from the block it resembles.
export function pageInlineClauses(mdx) {
  const prose = mdx.split("<TestPlan>")[0].replace(/```[^\n]*\n[\s\S]*?```/g, "");
  const out = [];
  // Matched as a pattern, placeholders as gaps: `ALTER DATABASE <DATABASE_NAME> SET …` on the
  // telemetry page is run as `ALTER DATABASE postgres SET …`.
  // Pair every span first, then keep the long ones: a length rule inside the pattern lets a short
  // span (`\copy`) fail, and the scan then restarts at its closing backtick and reads the prose up
  // to the next span as a "clause".
  for (const m of prose.matchAll(/`([^`\n]+)`/g)) if (m[1].length >= 16 && /\s/.test(m[1])) out.push(inlineStatementToRegExp(m[1].replace(/;$/, "")));
  return out;
}

export function statementsDriftedFromPage(mdx, plan, { threshold = 0.6 } = {}) {
  const pageStmts = pageStatements(mdx);
  const patterns = pageStmts.map(pageStatementToRegExp);
  const clauses = pageInlineClauses(mdx);
  const out = [];
  for (const [idx, step] of plan.steps.entries()) {
    for (const a of step.actions || []) {
      // An `expect error:` carries a statement the page gives and says must fail, so it is graded
      // like `run SQL:`; every other assertion has no counterpart in prose.
      if (a.assertion && !a.expectError) continue;
      const texts = a.expectError ? [a.expectError.statement] : a.sql ? planSqlParts(a.sql) : a.command ? [a.command] : [];
      for (const text of texts) {
      const norm = normalize(text);
      const forms = commandForms(text).map(squeeze);
      if (patterns.some((re) => forms.some((f) => re.test(f)))) continue; // matches a page block outright, in some form
      if (clauses.some((re) => forms.some((f) => re.test(f)))) continue; // carries a variant the page spells out inline
      let best = null;
      let bestScore = 0;
      for (const cand of pageStmts) {
        const sc = similarity(text, cand);
        if (sc > bestScore) { bestScore = sc; best = cand; }
      }
      if (bestScore >= threshold) {
        out.push({ step: idx + 1, statement: norm.slice(0, 90), closest: normalize(best).slice(0, 90), score: Number(bestScore.toFixed(2)) });
      }
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Does the plan cover what the page documents? Three checks that look from the PAGE'S side.
// ---------------------------------------------------------------------------
//
// The two checks above grade what the plan does against the page. Nothing graded what the plan
// LEAVES OUT: a plan could skip a whole procedure or a whole SQL block and lint clean, and the only
// record of an omission was the author-written `Not scripted:` list, which nothing read. These three
// read it, and report what is neither covered nor excused:
//
//   - a `##`/`###` section with a <NumberedList> that no plan step touches           (procedure)
//   - a SQL block the page prints that no `run SQL:`/`run command:` step executes    (statement)
//   - a statement the plan runs AFTER one that the page prints later                 (order)
//
// "Touches" is deliberately generous: one pressed control named in the section, or one statement
// from it, counts. This is a coverage floor, not a step-for-step grade; that idea was tried and
// deleted for flagging every plan everywhere.

const norm = (s) =>
  String(s)
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/[`*_]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();

// The page's prose split into heading-delimited sections, constants resolved. A section runs from
// its heading to the next heading of ANY level, so a `##` with `###` children owns only its own
// intro; the leading section, before any heading, is kept too because a partial rendered as a page
// (passwordless access) has its procedure there and no heading of its own.
function pageSections(mdx, C) {
  let prose = mdx.split("<TestPlan>")[0];
  if (C) prose = prose.replace(/\$?\{C\.(\w+)\}/g, (_, k) => C[k] ?? "");
  prose = prose.replace(/title=\{`([\s\S]*?)`\}/g, (_, inner) => inner.replace(/\\`/g, "`")).replace(/\\`/g, "`");
  const lines = prose.split("\n");
  const out = [];
  // A page with per-platform <Tabs> (install-toolkit: ten tabs, each repeating the same three
  // headings) repeats a heading once per tab, so a heading key alone cannot excuse one tab without
  // excusing them all, and the plan's own tab went unchecked. Each section therefore also carries
  // the labels of the tabs enclosing it, outermost first, so a `Not scripted:` entry keyed
  // `<label> tab` excuses exactly that tab's sections.
  //
  // The fragments of one heading still form ONE procedure for the coverage and order checks: a
  // quickstart step whose <Tabs> offer psql or the Console is covered by either route, and same-db's
  // "With indexes" / "Without indexes" routes are walked in turn. `key` names that procedure: the
  // heading plus the tabs the HEADING itself sits under, so install-toolkit's ten `## Install`
  // headings (one per tab) stay ten procedures while a tab nested under a heading stays part of it.
  const tabs = [];
  const keyOf = (heading, parent, headingTabs) => `${heading ?? ""}|${parent ?? ""}|${headingTabs.join(">")}`;
  let cur = { level: 0, heading: null, parent: null, tabs: [], key: keyOf(null, null, []), lines: [] };
  let lastH2 = null;
  let inFence = false;
  for (const line of lines) {
    if (/^\s*```/.test(line)) inFence = !inFence;
    if (!inFence) {
      const t = line.match(/<TabItem\s+label=["']([^"']+)["']/);
      if (t) {
        // The closing tag is tracked explicitly so nested <Tabs> (Linux > Debian) keep their outer label.
        tabs.push(norm(t[1]));
        out.push(cur);
        cur = { ...cur, tabs: [...tabs], lines: [] };
      }
      if (/<\/TabItem>/.test(line)) {
        tabs.pop();
        out.push(cur);
        cur = { ...cur, tabs: [...tabs], lines: [] };
        continue;
      }
    }
    const h = !inFence && line.match(/^(#{2,4})\s+(.+?)\s*$/);
    if (h) {
      out.push(cur);
      const level = h[1].length;
      const heading = norm(h[2]);
      if (level === 2) lastH2 = heading;
      const parent = level > 2 ? lastH2 : null;
      cur = { level, heading, parent, tabs: [...tabs], key: keyOf(heading, parent, tabs), lines: [] };
      continue;
    }
    cur.lines.push(line);
  }
  out.push(cur);
  return out.map((s) => ({ ...s, body: s.lines.join("\n") })).filter((s) => s.lines.length);
}

// The `Not scripted:` list at the foot of the plan: one entry per line, keyed to a heading verbatim,
// with the reason after the first colon. Read as data here; it is still commentary to the run.
// A page may carry more than one block (one per product); each may declare its own list, and a
// heading excused by either is excused.
function notScriptedKeys(mdx) {
  const keys = [];
  for (const block of mdx.split("<TestPlan>").slice(1)) {
    const i = block.search(/^\s*Not scripted:\s*$/m);
    if (i < 0) continue;
    const lines = block.slice(i).split("\n");
    const header = lines.findIndex((l) => /^\s*Not scripted:\s*$/.test(l));
    for (const line of lines.slice(header + 1)) {
      const m = line.match(/^\s*-\s+(.+)$/);
      if (!m) { if (line.trim() && !/^\s{2,}/.test(line)) break; continue; }
      keys.push(norm(m[1].split(/:(?!\/)/)[0]));
    }
  }
  return keys;
}

// A key is a heading (matched loosely, as before) or `<label> tab`, which matches a tab label
// exactly: `Debian tab` must not excuse `Ubuntu`, and `Linux tab` excuses every tab nested in it.
const excused = (section, keys) =>
  keys.some((k) => {
    if (!k) return false;
    const tab = k.match(/^(.+?)\s+tab$/);
    if (tab) return (section.tabs || []).includes(tab[1]);
    return [section.heading, section.parent].filter(Boolean).some((h) => h === k || h.includes(k) || k.includes(h));
  });

const SQL_SHAPE = /^(\\copy|select|insert|update|delete|create|alter|drop|set|reset|show|call|with|explain|grant|revoke|copy|begin|commit|rollback|vacuum|analyze|refresh|truncate|do|comment|merge)\b/i;

// The ```sql statements a section prints, statement-shaped only: output samples are fenced as sql
// too, and a table of results starts with a column name or whitespace rather than a keyword.
// Shell fences count as well, because a page's `psql … -c "SHOW STATS;"` is what a `run command:`
// step executes: without them the pgBouncer statistics procedure read as uncovered while its one
// command was being run. A shell line is a statement when it invokes a client the plan can run.
// `postgres` and `go` only when followed by what a command line has (`postgres -c …`, `go install …`),
// so a `postgres=#` prompt in a transcript or the word in prose stays prose.
const SHELL_SHAPE = /^(psql|tiger|pg_dump|pg_restore|pg_basebackup|pgcopydb|curl|timescaledb-parallel-copy|timescaledb-tune|docker|postgres(?=\s+-)|go(?=\s+(?:install|get|run)\b)|[A-Z_]+=\S+\s+(?:\\\s*)?(psql|tiger))\b/;
// `psql -d "$TARGET"` opens a session for the statements that follow; there is nothing for a plan to
// run for it, so it is not a statement. A psql that carries -c, -f or a redirect is.
const PSQL_CONNECT_ONLY = /^psql\b(?!.*(?:\s-c\b|\s--command\b|\s-f\b|\s--file\b|\s<\s|\|))/;
// `docker exec -it timescaledb psql -U postgres -d <db>` (install-toolkit's Docker tab) is the same
// connect-only line with the container in front of it: nothing to run, and `-it` cannot run over
// SSM anyway. The prefix comes off before the connect-only test and before the psql payload is read.
const DOCKER_EXEC_PREFIX = /^docker\s+exec\s+(?:-{1,2}[\w-]+(?:[= ]\S+)?\s+)*\S+\s+(?=psql\b)/;
function sectionStatements(body) {
  const out = [];
  for (const m of body.matchAll(/```(sql|bash|shell|sh|zsh)[^\n]*\n([\s\S]*?)```/g)) {
    const lang = m[1];
    if (lang === "sql") {
      if (isSynopsis(m[2])) continue;
      // Split on meta-command lines too: a page that prints `\c <db>` above `CREATE EXTENSION` in one
      // block (logical-backup) otherwise reads as a single statement no plan can match.
      for (const part of splitSqlStatements(stripSqlLineComments(m[2]).replace(META_LINE, ""))) {
        const t = part.trim();
        if (t && SQL_SHAPE.test(t)) out.push(t);
      }
    } else {
      // One command per line, continuation lines joined; comments and prompts dropped.
      const joined = m[2].replace(/\\\n\s*/g, " ");
      for (const line of joined.split("\n")) {
        const t = line.replace(/^\s*\$\s+/, "").trim().replace(SUDO_PREFIX, "");
        if (t && !t.startsWith("#") && SHELL_SHAPE.test(t) && !PSQL_CONNECT_ONLY.test(t.replace(DOCKER_EXEC_PREFIX, ""))) out.push(t);
      }
    }
  }
  return out;
}

// The EC2 target runs every `run command:` as root, so a self-hosted plan writes the page's `pg_dump`
// as `sudo -u postgres pg_dump`, and SQL bound for a second database as `psql -d restored -c "..."`.
// The page statement is still in there. These are the forms a plan command is compared under: as
// written, without the sudo prefix, and the SQL a psql -c carries.
const SUDO_PREFIX = /^sudo\s+(?:-[a-zA-Z]+\s+(?:\S+\s+)?)*/;
const PSQL_PAYLOAD = /(?:^|\s)(?:-c|--command[= ])\s*(?:"((?:[^"\\]|\\.)*)"|'([^']*)'|(\S+))/;
// A page that documents errors a command may print and says they are safe to ignore (pg_restore on
// schema-then-data) leaves the plan one honest way to run it: capture stderr to a file, accept the
// non-zero exit, and assert on the file in the next step. The redirect and the `|| true` are the
// wrapper, not the command, so they come off before comparing.
const IGNORED_ERRORS_SUFFIX = /(?:\s*(?:2>&1|2>\s*\S+|>\s*\S+|\|\|\s*true))+\s*$/;
// The environment a reader has and the plan must spell out: `PGDATA=… nohup /usr/lib/postgresql/18/bin/postgres
// … &` is the page's `postgres …` (postgres-config), the variables, the nohup, the binary's directory
// and the trailing `&` all being how the plan gets a server to start and the step to return.
// `yes |` in front answers prompts the page expects a person to answer.
const ENV_PREFIX = /^(?:[A-Z_][A-Z0-9_]*=\S*\s+)+/;
const DETACH_PREFIX = /^(?:nohup\s+|yes\s*\|\s*)+/;
const BACKGROUND_SUFFIX = /\s*&\s*$/;
const COMMAND_DIR = /^\/\S*\/(?=[\w.-]+(?:\s|$))/;
export function commandForms(text) {
  const forms = [text];
  const unwrapped = text.replace(BACKGROUND_SUFFIX, "").replace(IGNORED_ERRORS_SUFFIX, "");
  if (unwrapped !== text) forms.push(unwrapped);
  // Sudo off with the redirect kept, too: a page that itself prints `pg_dump … > schema.sql`
  // (logical-backup) is matched by neither the wrapped form (sudo in the way) nor the unwrapped
  // one (redirect gone), so the plan's statement read as never run.
  const sudoless = text.replace(SUDO_PREFIX, "");
  if (sudoless !== text && sudoless !== unwrapped) forms.push(sudoless);
  let bare = unwrapped.replace(SUDO_PREFIX, "");
  if (bare !== unwrapped) forms.push(bare);
  const plain = bare.replace(ENV_PREFIX, "").replace(DETACH_PREFIX, "").replace(COMMAND_DIR, "");
  if (plain !== bare) { forms.push(plain); bare = plain; }
  const undockered = bare.replace(DOCKER_EXEC_PREFIX, "");
  if (undockered !== bare) { forms.push(undockered); bare = undockered; }
  if (/^psql\b/.test(bare)) {
    const m = bare.match(PSQL_PAYLOAD);
    const payload = m && (m[1] ?? m[2] ?? m[3]);
    if (payload) forms.push(payload.replace(/\\"/g, '"').replace(/;\s*$/, ""));
  }
  return forms;
}

// A step may carry several statements in one body: a page's `BEGIN; … COMMIT;` block, or a `CREATE
// TEMP TABLE` followed by the statements that use it, must run in ONE session, and the only way a
// plan says that is one multi-line `run SQL:` step. Split the same way pageStatements splits a page
// block, so each statement in the body is compared on its own; before this, every statement of such
// a step read as "not run" and the step itself scored as drift against nothing.
function planSqlParts(sql) {
  return splitSqlStatements(stripSqlLineComments(sql)).map((s) => s.trim()).filter(Boolean);
}

function planStatements(plan) {
  const out = [];
  for (const [idx, step] of plan.steps.entries()) {
    for (const a of step.actions || []) {
      if (a.expectError) {
        // The statement under test is what the plan runs, so a page fence the prose says fails counts as run.
        out.push({ step: idx + 1, text: a.expectError.statement, forms: commandForms(a.expectError.statement).map(squeeze) });
        continue;
      }
      if (a.assertion) continue;
      if (a.sql) {
        for (const text of planSqlParts(a.sql)) out.push({ step: idx + 1, text, forms: commandForms(text).map(squeeze) });
        continue;
      }
      const text = a.command || null;
      if (text) out.push({ step: idx + 1, text, forms: commandForms(text).map(squeeze) });
    }
  }
  return out;
}

const headingLabel = (s) => (s.heading ? `"${s.heading}"` : "the section before the first heading");

/**
 * Documented procedures the plan neither drives nor declares under `Not scripted:`.
 * Returns [{ heading }].
 */
export function proceduresNotCovered(mdx, plan, docsRepo) {
  const C = loadConstants(docsRepo);
  const keys = notScriptedKeys(mdx);
  const pressed = [];
  for (const step of plan.steps) {
    for (const a of step.actions || []) { const l = pressedLabel(a); if (l) pressed.push(l); }
    if (step.testInput) { const m = /\binto\s+`([^`]+)`/i.exec(step.text); if (m) pressed.push(m[1]); }
  }
  const ran = planStatements(plan).flatMap((s) => s.forms);
  const out = [];
  // One procedure per heading key; its tab fragments are judged together (see pageSections).
  const procedures = new Map();
  for (const s of pageSections(mdx, C)) {
    const p = procedures.get(s.key) || { first: s, fragments: [] };
    p.fragments.push(s);
    procedures.set(s.key, p);
  }
  for (const { first, fragments } of procedures.values()) {
    const body = fragments.map((f) => f.body).join("\n");
    if (!/<NumberedList\b/.test(body)) continue;
    const controls = { set: new Set(), text: body.replace(/\s+/g, " ").toLowerCase() };
    for (const m of body.matchAll(/`([^`\n]+)`/g)) controls.set.add(m[1].trim().toLowerCase());
    const patterns = sectionStatements(body).map(pageStatementToRegExp);
    // A procedure may name its statements only in code font ("run `SHOW STATS;`"), with no fence at
    // all; a plan command that carries that span verbatim is running it.
    const spans = [...controls.set].map((c) => c.replace(/\s+/g, "")).filter((c) => c.length >= 6);
    const covered =
      pressed.some((l) => isNamed(l, controls)) ||
      ran.some((r) => patterns.some((re) => re.test(r)) || spans.some((c) => r.includes(c)));
    if (!covered && !fragments.some((f) => excused(f, keys))) out.push({ heading: headingLabel(first) });
  }
  return out;
}

/**
 * SQL the page prints that no plan step runs, outside sections declared `Not scripted:`.
 * Returns [{ heading, statement }].
 */
// Statements a page prints in inline code rather than a fenced block: `VACUUM FULL` in a tip,
// `convert_to_columnstore('<chunk_name>', recompress => true)` in a link, `SET
// timescaledb.enable_direct_compress_auto_segmentby = off` in a list of facts. A reader is told to
// run them just the same, and six of them on three pages were missed by plans the block check
// called clean (2026-10-09). A span counts when it starts like a statement (same shape rule as a
// block) or is a call with a named argument, which is how the docs write a function the reader
// invokes. A span with an ellipsis is syntax the page is naming, not a statement (`INSERT INTO ...
// VALUES ... ON CONFLICT ... DO UPDATE`), and a lone keyword is a word, not a statement, unless the
// word is a complete statement by itself.
const INLINE_CALL = /^[a-z_][a-z0-9_.]*\(.*=>.*\)$/i;
const LONE_STATEMENT = /^(vacuum|analyze|begin|commit|rollback)$/i;
function sectionInlineStatements(body) {
  const prose = body.replace(/```[^\n]*\n[\s\S]*?```/g, "");
  const out = [];
  for (const m of prose.matchAll(/`([^`\n]+)`/g)) {
    const s = m[1].trim();
    if (/\.{3}|…/.test(s)) continue;
    const words = s.split(/\s+/);
    if (words.length === 1 && !LONE_STATEMENT.test(s) && !INLINE_CALL.test(s)) continue;
    // House style writes SQL keywords in capitals and Console controls in sentence case, both in
    // code font: `CREATE MATERIALIZED VIEW` is a statement, `Create continuous aggregate` is a button.
    // A trailing semicolon is a statement whatever its case (`show data_directory;`).
    const statementCase = /^\\copy\b/i.test(s) || /^[A-Z]+\b/.test(s) || /;$/.test(s);
    if ((SQL_SHAPE.test(s) && statementCase) || INLINE_CALL.test(s)) out.push(s.replace(/;$/, ""));
  }
  return out;
}

export function statementsNotRun(mdx, plan, docsRepo) {
  const C = loadConstants(docsRepo);
  const keys = notScriptedKeys(mdx);
  const ran = planStatements(plan).flatMap((s) => s.forms);
  const out = [];
  for (const s of pageSections(mdx, C)) {
    if (excused(s, keys)) continue;
    for (const stmt of sectionStatements(s.body)) {
      const re = pageStatementToRegExp(stmt);
      if (!ran.some((r) => re.test(r))) out.push({ heading: headingLabel(s), statement: normalize(stmt).slice(0, 90) });
    }
    for (const stmt of sectionInlineStatements(s.body)) {
      const re = inlineStatementToRegExp(stmt);
      if (!ran.some((r) => re.test(r))) out.push({ heading: headingLabel(s), statement: normalize(stmt).slice(0, 90), inline: true });
    }
  }
  return out;
}

/**
 * Plan statements that match a page block printed EARLIER than the block the previous statement
 * matched, when no later occurrence exists. Fixtures match nothing and are ignored; a statement the
 * page prints twice (an index rebuilt in a later section) matches forward to its later copy.
 * Returns [{ step, statement }].
 */
export function statementsOutOfPageOrder(mdx, plan, docsRepo) {
  const C = loadConstants(docsRepo);
  const page = []; // { re, section } in page order
  pageSections(mdx, C).forEach((s) => { for (const stmt of sectionStatements(s.body)) page.push({ re: pageStatementToRegExp(stmt), section: s.key }); });
  const out = [];
  let cursor = -1;
  const visited = new Set(); // sections the plan has run a statement from
  for (const { step, text, forms } of planStatements(plan)) {
    const hit = (p) => forms.some((f) => p.re.test(f));
    const next = page.findIndex((p, i) => i > cursor && hit(p));
    if (next >= 0) { cursor = next; visited.add(page[next].section); continue; }
    const earlier = page.findIndex((p, i) => i <= cursor && hit(p));
    if (earlier < 0) continue; // a fixture: the page never prints it
    // Going back INTO a section the plan has already run something from is the second route of the
    // same procedure (walk each route in turn, undoing between), and the page may print that route's
    // copy of a statement in a tab before the one the plan walked first. Going back to a section the
    // plan has not touched yet is a procedure done out of the page's order, which is what this
    // reports.
    if (visited.has(page[earlier].section)) continue;
    visited.add(page[earlier].section);
    out.push({ step, statement: normalize(text).slice(0, 90) });
  }
  return out;
}

// ---------------------------------------------------------------------------
// A bare plan against the reader's path (docs/adr/0010).
// ---------------------------------------------------------------------------
//
// An install-guide run is only evidence about the guide if the plan runs the guide's commands. The
// Console checks above compare whole-page, fuzzy, and only the statements a whitelist knows; for a
// `machine: bare` plan the contract is stricter (docs/adr/0007, verbatim), so this check is too:
//
//   - the scope is the reader's path (the Linux tab, the plan's distro tab, and the shared steps
//     around them), never the whole page, where every other distro's fences would read as missing;
//   - a command is one logical command out of a bash/sh/shell fence, and equality is on its text;
//   - every guide command is run or declared `skip`, and a plan runs nothing the page does not give;
//   - a `<placeholder>` in a guide command matches any text, because the reader substitutes too.
//
// Run steps the page cannot contain are out of scope on purpose: `expect rows:` and `run SQL:` (the
// SQL checks above own those), and `answer` replies other than a line typed at a psql prompt, which
// are the declared grammar of ADR 0007 (`y`, `<Enter>`, a password).

const TESTPLAN_BLOCK = /<TestPlan\b[^>]*>[\s\S]*?<\/TestPlan>/g;
const FENCE = /^[ \t]*```(\w*)[^\n]*\n([\s\S]*?)^[ \t]*```/gm;
const SHELL_FENCE = /^(bash|sh|shell)$/;
const PSQL_PROMPT = /^[\w$-]*[=-][#>]$/; // postgres=#  postgres-#  tsdb=>
// `<username>`, and also a path the reader substitutes, such as the Docker guide's `</a/local/data/folder>`.
const GUIDE_PLACEHOLDER = /<\/?[A-Za-z][\w/-]*>/g;

// Every fixture lives under here, and `DOCS_REPO` pointing inside it is how a run says so.
const FIXTURES_DIR = join(import.meta.dirname, "..", "dev-fixtures");
export const isDevFixtureRepo = (docsRepo) => resolve(docsRepo).startsWith(FIXTURES_DIR + sep);

// <TabItem label="X"> ... </TabItem>, with how deep each sits. Self-closing and unlabelled tags are
// not tabs a reader picks.
function tabItems(text) {
  const out = [];
  const stack = [];
  for (const m of text.matchAll(/<(\/?)TabItem\b([^>]*)>/g)) {
    if (!m[1]) {
      stack.push({ label: m[2].match(/\blabel\s*=\s*["']([^"']+)["']/)?.[1], start: m.index, bodyStart: m.index + m[0].length });
    } else {
      const open = stack.pop();
      if (open) out.push({ ...open, bodyEnd: m.index, end: m.index + m[0].length, depth: stack.length });
    }
  }
  return out;
}

// Choose one tab at each level: the text a reader sees keeps what sits outside the tab group, drops
// the sibling tabs, and shows the chosen tab's own body. Returns null when a label is not on the page.
export function readerPath(mdx, labels) {
  let text = mdx.replace(TESTPLAN_BLOCK, "");
  for (const label of labels) {
    const tops = tabItems(text).filter((t) => t.depth === 0);
    const chosen = tops.find((t) => t.label === label);
    if (!chosen) return { missing: label };
    let out = "";
    let at = 0;
    for (const t of tops) {
      out += text.slice(at, t.start) + (t === chosen ? text.slice(t.bodyStart, t.bodyEnd) : "");
      at = t.end;
    }
    text = out + text.slice(at);
  }
  return { text };
}

// One logical command per entry: `\` continuations joined, a heredoc kept through its terminator,
// a leading `$ ` and comment-only lines dropped. Whitespace is collapsed within a command's own line,
// and line breaks are kept. A heredoc's body is a file, and its lines are not interchangeable: they keep
// their indentation relative to each other, and only the indent the whole body shares is dropped (a
// page may indent a fence's contents, and a YAML manifest's indentation is its meaning, docs/adr/0011).
// The terminator is found even when the page indents it, so what follows is not swallowed; that the
// page indents it is its own finding (heredocFindings).
export function logicalCommands(body) {
  const lines = body.split("\n");
  const out = [];
  let i = 0;
  while (i < lines.length) {
    let l = lines[i++].replace(/^\s*\$\s+/, "").trim();
    if (!l || l.startsWith("#")) continue;
    while (l.endsWith("\\") && i < lines.length) l = `${l.slice(0, -1).trimEnd()} ${lines[i++].trim()}`;
    l = l.replace(/[ \t]+/g, " ");
    const h = l.match(/<<-?\s*['"]?(\w+)['"]?/);
    if (h) {
      const text = [];
      let ended = false;
      while (i < lines.length) {
        const x = lines[i++];
        if (x.trim() === h[1]) { ended = true; break; }
        text.push(x.trimEnd());
      }
      const lead = (s) => s.match(/^[ \t]*/)[0].length;
      const common = Math.min(...text.filter((x) => x.trim()).map(lead), Infinity);
      l = [l, ...text.map((x) => (Number.isFinite(common) ? x.slice(common) : x)), ...(ended ? [h[1]] : [])].join("\n");
    }
    out.push(l);
  }
  return out;
}

// A heredoc ends only at its terminator in column 0 (`<<-` also takes tabs), so a reader who pastes a
// fence whose terminator the page indents gets a command that never ends. `body` is a fence's contents
// as a reader copies them: already without the fence's own indent. -> [{ cmd, detail }]
export function heredocFindings(body) {
  const lines = body.split("\n");
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const h = lines[i].match(/<<(-?)\s*['"]?(\w+)['"]?/);
    if (!h || /^\s*#/.test(lines[i])) continue;
    let j = i + 1;
    while (j < lines.length && lines[j].trim() !== h[2]) j++;
    const cmd = lines[i].trim();
    if (j === lines.length) { out.push({ cmd, detail: `no \`${h[2]}\` line ends it` }); break; }
    const lead = lines[j].match(/^[ \t]*/)[0];
    if (lead && !(h[1] && /^\t+$/.test(lead))) out.push({ cmd, detail: `its \`${h[2]}\` is indented ${lead.length} ${lead.length === 1 ? "space" : "spaces"}, so it does not end the heredoc` });
    i = j;
  }
  return out;
}

// A fence's contents as a reader copies them: without the indent the fence itself opens at.
const fenceBody = (m) => {
  const open = m[0].match(/^[ \t]*/)[0];
  return open ? m[2].split("\n").map((l) => (l.startsWith(open) ? l.slice(open.length) : l)).join("\n") : m[2];
};

// What the page gives a reader. `fenced` is the commands in shell fences, and the only thing a plan
// must run. `traceable` is what a plan MAY run besides: lines and whole statements from `sql` fences
// (what a reader types at the psql prompt; the fence also holds sample output, so none of it is
// required) and inline-code spans (prose in code font is not always a command).
//
// `untagged` is the commands in fences not tagged as shell (no tag, or another one such as `yaml`) that
// LOOK like commands. The lint reads only shell-tagged fences (docs/adr/0010), so such a fence is
// invisible to it: the Docker guide's `docker pull` and `docker run` are in untagged ones, and the
// Kubernetes guide's `kubectl apply` for the PVC, StatefulSet and Service are in `yaml` ones. They are
// never required of a plan; they are reported, so the lint cannot pass over them in silence
// (docs/adr/0011). "Looks like a command" is a heuristic with a known ceiling: the first word is one the
// page's own shell fences start a command with, or is in COMMAND_WORDS. A fence of sample output or of a
// bare manifest starts with neither.
//
// `heredocs` is the fences' heredocs whose terminator a reader's paste would not end (heredocFindings),
// over the shell fences and those untagged ones.
const COMMAND_WORDS = new Set(["sudo", "docker", "kubectl", "helm", "psql", "apt", "apt-get", "dnf", "yum", "brew", "curl", "wget", "systemctl", "git", "make", "cmake", "tee", "export"]);
const firstWord = (cmd) => cmd.replace(/^\s*\$\s+/, "").split(/\s/)[0];
export function guideCommands(scope) {
  const fenced = [];
  const traceable = [];
  const otherAll = [];
  const bodies = [];
  for (const m of scope.matchAll(FENCE)) {
    const body = fenceBody(m);
    if (SHELL_FENCE.test(m[1])) { fenced.push(...logicalCommands(body)); bodies.push({ body, shell: true }); }
    else if (m[1] === "sql") traceable.push(...logicalCommands(body), logicalCommands(body).join(" "));
    else { otherAll.push(...logicalCommands(body)); bodies.push({ body, shell: false }); }
  }
  const words = new Set([...COMMAND_WORDS, ...fenced.map(firstWord)]);
  const untagged = otherAll.filter((c) => words.has(firstWord(c)));
  const heredocs = bodies.filter((b) => b.shell || logicalCommands(b.body).some((c) => words.has(firstWord(c)))).flatMap((b) => heredocFindings(b.body));
  // A JSX attribute such as title={`Install ${C.PG}`} holds backticks that are not code.
  const prose = scope.replace(FENCE, "").replace(/\w+=\{`(?:\\`|[^`])*`\}/g, "");
  for (const m of prose.matchAll(/`([^`\n]+)`/g)) traceable.push(...logicalCommands(m[1]).slice(0, 1));
  return { fenced, traceable, untagged, heredocs };
}

// A guide command as a pattern: each <placeholder> stands for any text.
// A command that is nothing but placeholders (`<database-name>` in prose) would match anything, so
// it matches only itself.
const guidePattern = (g) => {
  const parts = g.split(GUIDE_PLACEHOLDER).map((x) => x.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  if (!parts.join("").trim()) return new RegExp(`^${g.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`);
  return new RegExp(`^${parts.join("[\\s\\S]+?")}$`);
};
const sameCommand = (planCmd, guideCmd) => planCmd === guideCmd || guidePattern(guideCmd).test(planCmd);

/**
 * A bare plan block against the page. Returns [{ kind, step?, plan?, guide?, label? }], kinds:
 *   `tab not on page`    the reader's path names a tab the page does not have
 *   `guide command not run`   in the page's fences, not run and not declared `skip`
 *   `command not on page`     the plan runs something the page does not give
 *   `command changed`         the plan's command and a not-run guide command are near-misses
 *   `out of page order`       run before a command the page gives earlier
 *   `stale skip`              a `skip` whose command is not on the page, or is run anyway
 */
// The commands a plan runs and the ones it declares `skip`, each with its step.
function ranAndSkipped(plan) {
  const ran = [];
  const skips = [];
  for (const step of plan.steps) {
    for (const a of step.actions || []) {
      if (a.action === "run_shell") ran.push({ step: step.n, cmd: logicalCommands(a.command).join("\n") });
      else if (a.action === "answer" && PSQL_PROMPT.test(a.prompt.trim()) && !KEY_REPLY.test(a.reply)) ran.push({ step: step.n, cmd: logicalCommands(a.reply).join("\n") });
      else if (a.action === "skip_command") skips.push({ step: step.n, cmd: logicalCommands(a.command).join("\n") });
    }
  }
  return { ran, skips };
}

export function guideCommandDrift(mdx, plan) {
  const path = readerPath(mdx, pathLabels(plan));
  if (path.missing) return [{ kind: "tab not on page", label: path.missing }];
  const { fenced, traceable, untagged, heredocs } = guideCommands(path.text);
  const { ran, skips } = ranAndSkipped(plan);

  const out = [];
  // A fault of the page, not of the plan: the plan's own copy of the command ends its heredoc, and the
  // run would pass over a command no reader can paste (docs/adr/0011).
  for (const h of heredocs) out.push({ kind: "heredoc never ends as shown", plan: h.cmd, detail: h.detail });
  // A `wait` runs nothing the reader runs, so it is not a command the page must give, but the container
  // it names must be on the reader's path: a guide that renames it makes the wait a no-op (docs/adr/0011).
  for (const step of plan.steps) {
    for (const a of step.actions || []) {
      if (a.action !== "wait_postgres" && a.action !== "wait_pod_ready") continue;
      // A pod's name is the StatefulSet's plus an ordinal, and the page prints the StatefulSet's: so `NAME-N`
      // needs `NAME` on the path (the ordinal is not checked against `replicas`; a wrong one fails at the probe).
      const named = a.container ?? a.pod.replace(/-\d+$/, "");
      const esc = named.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      if (!new RegExp(`(?<![\\w.-])${esc}(?![\\w.-])`).test(path.text)) out.push({ kind: a.pod ? "wait names a pod not on the page" : "wait names a container not on the page", step: step.n, plan: a.pod ? `pod \`${a.pod}\`` : `container \`${a.container}\`` });
    }
  }
  // An `expect output contains` is tied to the page two ways (docs/adr/0011): the text must be in a
  // non-shell fence on the reader's path, which is where the page shows what a reader sees (a `sql` fence
  // holds typed input too, so this approximates "sample output"), and it must not be something the plan
  // itself types for that command, which the terminal would echo back and make the check trivially true.
  const shown = [...path.text.matchAll(FENCE)].filter((m) => !SHELL_FENCE.test(m[1])).map((m) => m[2]);
  let lastRun = null;
  for (const step of plan.steps) {
    for (const a of step.actions || []) {
      if (a.action === "run_shell") lastRun = a;
      else if (a.action === "expect_output" && lastRun) {
        const typed = [lastRun.command, ...(lastRun.answers || []).map((x) => x.reply)].join("\n");
        if (typed.includes(a.text)) out.push({ kind: "asserts text the plan itself types", step: step.n, plan: `\`${a.text}\`` });
        if (!shown.some((b) => b.includes(a.text))) out.push({ kind: "asserts text the page never shows", step: step.n, plan: `\`${a.text}\`` });
      }
    }
  }
  const covered = new Set();
  const extras = [];
  let cursor = -1;
  for (const r of ran) {
    const hits = fenced.flatMap((g, i) => (sameCommand(r.cmd, g) ? [i] : []));
    if (!hits.length) {
      if (!traceable.some((g) => sameCommand(r.cmd, g))) extras.push(r);
      continue;
    }
    const next = hits.find((i) => i > cursor && !covered.has(i)) ?? hits.find((i) => i > cursor);
    if (next === undefined) {
      // Only matches before the cursor: a second run of a command already run is fine (`\q` ends
      // each psql session), but one the page gives earlier than the last command is out of order.
      if (hits.every((i) => !covered.has(i))) out.push({ kind: "out of page order", step: r.step, plan: r.cmd });
      covered.add(hits[0]); // it was run, just in the wrong place: not also "not run", and not skippable
      continue;
    }
    covered.add(next);
    cursor = next;
  }

  const skipped = new Set();
  for (const k of skips) {
    const hits = fenced.flatMap((g, i) => (sameCommand(k.cmd, g) || sameCommand(g, k.cmd) ? [i] : []));
    // A skip of a command in an untagged fence is not stale: the page gives it, the lint just cannot
    // read it, and the skip is how a plan says it knows (it silences the advisory in untaggedFences).
    if (!hits.length) {
      if (!untagged.some((g) => sameCommand(k.cmd, g) || sameCommand(g, k.cmd))) out.push({ kind: "stale skip", step: k.step, plan: k.cmd, detail: "that command is not in the guide any more" });
    } else if (hits.some((i) => covered.has(i))) out.push({ kind: "stale skip", step: k.step, plan: k.cmd, detail: "the plan also runs it" });
    else hits.forEach((i) => skipped.add(i));
  }

  const missing = fenced.map((g, i) => ({ g, i })).filter(({ i }) => !covered.has(i) && !skipped.has(i));
  for (const e of extras) {
    // The page does give this command, in a fence the lint cannot read: say so, not "not on page".
    if (untagged.some((g) => sameCommand(e.cmd, g))) {
      out.push({ kind: "command in an untagged fence", step: e.step, plan: e.cmd });
      continue;
    }
    let best = null;
    let score = 0;
    for (const m of missing) {
      const sc = similarity(e.cmd, m.g);
      if (sc > score) { score = sc; best = m; }
    }
    if (best && score >= 0.6) {
      out.push({ kind: "command changed", step: e.step, plan: e.cmd, guide: best.g });
      missing.splice(missing.indexOf(best), 1);
    } else out.push({ kind: "command not on page", step: e.step, plan: e.cmd });
  }
  for (const m of missing) out.push({ kind: "guide command not run", guide: m.g });
  return out;
}

/**
 * Commands in untagged fences on the plan's reader's path that the plan does not run (the ones it does
 * run are findings of their own in guideCommandDrift). Advisory: they are not required of a plan, but
 * the lint cannot see them, so they are listed rather than skipped in silence (docs/adr/0011).
 */
export function untaggedFences(mdx, plan) {
  const path = readerPath(mdx, pathLabels(plan));
  if (path.missing) return [];
  const { untagged } = guideCommands(path.text);
  const { ran, skips } = ranAndSkipped(plan);
  return untagged.filter((g) => !ran.some((r) => sameCommand(r.cmd, g)) && !skips.some((k) => sameCommand(k.cmd, g) || sameCommand(g, k.cmd))).map((guide) => ({ guide }));
}
