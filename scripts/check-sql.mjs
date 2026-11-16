#!/usr/bin/env node
// Checks the two places a plan's SQL is rewritten before it reaches a database: the text the
// Console walker types into the SQL editor (`prepareSqlForInsert`, with `stripSqlLineComments` under it),
// and the DO block `expect rows:` compiles to. No AWS, no browser, no database: the second is checked as
// the text it produces.
//
// Most of this is the behaviour the code means to have, paired with the near-miss that must not happen
// (a `--` inside a string is not a comment). Cases named "known" pin what the code does TODAY where that
// is a limit or a bug, so changing it is a visible decision and not a silent one: see the comments.
import assert from "node:assert/strict";
import { prepareSqlForInsert as prep } from "../lib/walk.mjs";
import { parsePlan } from "../lib/plan.mjs";
import { describeEditorMismatch as mism } from "../lib/sql-text.mjs";

let failed = 0;
const check = (name, fn) => {
  try { fn(); console.log(`  ok   ${name}`); } catch (e) { failed++; console.log(`  FAIL ${name}\n       ${String(e.message).split("\n").join("\n       ")}`); }
};
const Q = "'"; // keeps the cases below readable

console.log("prepareSqlForInsert: one line, no comments");
check("a statement collapses to one line: runs of whitespace, tabs and newlines become one space, and it is trimmed", () => {
  assert.equal(prep("SELECT   a,\n\tb\n  FROM   t"), "SELECT a, b FROM t");
  assert.equal(prep("   \n  "), "");
});
check("a `--` comment is removed, whole line or trailing, and the statements either side stay separate", () => {
  assert.equal(prep("SELECT 1; -- trailing\nSELECT 2;"), "SELECT 1; SELECT 2;");
  assert.equal(prep("-- header\nSELECT 1"), "SELECT 1");
});
check("a comment does not weld the tokens either side of it together", () => {
  assert.equal(prep("SELECT 1--c\nFROM t"), "SELECT 1 FROM t");
});
check("a `--` inside a string literal or a quoted identifier is text, not a comment (the near-miss)", () => {
  assert.equal(prep(`SELECT ${Q}--${Q}, ${Q}a--b${Q}`), `SELECT ${Q}--${Q}, ${Q}a--b${Q}`);
  assert.equal(prep('SELECT "a--b" FROM t'), 'SELECT "a--b" FROM t');
});
check("a doubled quote is an escape inside its literal, so the literal does not end there", () => {
  assert.equal(prep(`SELECT ${Q}it${Q}${Q}s -- fine${Q} -- gone`), `SELECT ${Q}it${Q}${Q}s -- fine${Q}`);
});
check("a dollar-quoted body (`$$`) is returned exactly as written, comments and layout included", () => {
  const body = "DO $$ BEGIN  -- c\n  NULL;  END $$;";
  assert.equal(prep(body), body);
});

console.log("prepareSqlForInsert: what it does today where that is a limit");
check("known (documented in the source): a TAGGED dollar body is not recognised, so its comments go and its layout collapses", () => {
  assert.equal(prep("DO $t$ BEGIN  -- c\n  NULL;  END $t$;"), "DO $t$ BEGIN NULL; END $t$;");
});
check("whitespace INSIDE a string literal or quoted identifier is kept: `'two  spaces'` is typed as written", () => {
  assert.equal(prep(`SELECT ${Q}two  spaces${Q}, ${Q}a\tb${Q}`), `SELECT ${Q}two  spaces${Q}, ${Q}a\tb${Q}`);
  assert.equal(prep('SELECT "a  b"   FROM t'), 'SELECT "a  b" FROM t');
});
check("whitespace AROUND a literal still collapses (the control for the one above)", () => {
  assert.equal(prep(`SELECT   ${Q}x  y${Q}\n   ,\n  ${Q}z${Q}`), `SELECT ${Q}x  y${Q} , ${Q}z${Q}`);
  assert.equal(prep(`SELECT ${Q}it${Q}${Q}s  ok${Q}   FROM t`), `SELECT ${Q}it${Q}${Q}s  ok${Q} FROM t`);
});
check("a line break INSIDE a literal or quoted identifier is refused, loudly: a one-line write cannot carry it", () => {
  assert.throws(() => prep(`SELECT ${Q}a\nb${Q}`), /line break.*string literal/);
  assert.throws(() => prep(`SELECT ${Q}a\r\nb${Q}`), /line break/);
  assert.throws(() => prep('SELECT "a\nb" FROM t'), /line break/);
});
check("a line break OUTSIDE a literal is not refused, even next to one (the control for the one above)", () => {
  assert.equal(prep(`SELECT ${Q}a${Q}\nFROM t\nWHERE x = ${Q}b${Q}`), `SELECT ${Q}a${Q} FROM t WHERE x = ${Q}b${Q}`);
});
check("a quote inside a /* block comment */ is comment text: it neither opens a literal nor stops the collapse", () => {
  assert.equal(prep(`/* it${Q}s  here */ SELECT ${Q}a  b${Q}`), `/* it${Q}s here */ SELECT ${Q}a  b${Q}`);
  assert.equal(prep(`/* a\nb */ SELECT 1`), "/* a b */ SELECT 1");
});
check("a line break inside a comment that mentions a quote does not trip the refusal", () => {
  assert.equal(prep(`SELECT 1 -- it${Q}s\nFROM t`), "SELECT 1 FROM t");
});
check("a `--` inside a /* block comment */ is comment text: the block is kept whole and the SQL after it survives", () => {
  assert.equal(prep("/* a -- b */ SELECT 1"), "/* a -- b */ SELECT 1");
  assert.equal(prep("SELECT 1 /* x -- y */ + 2"), "SELECT 1 /* x -- y */ + 2");
});
check("a block comment spanning lines, with a `--` in it, is kept and its layout collapses like the rest", () => {
  assert.equal(prep("/* one\n -- two\n three */\nSELECT 1"), "/* one -- two three */ SELECT 1");
});
check("block comments nest, as in Postgres, so the first `*/` does not end the outer one", () => {
  assert.equal(prep("/* a /* b -- c */ d -- e */ SELECT 1"), "/* a /* b -- c */ d -- e */ SELECT 1");
});
check("an unterminated block comment keeps the rest of the text, and does not throw", () => {
  assert.equal(prep("SELECT 1 /* never -- closed"), "SELECT 1 /* never -- closed");
});
check("a real `--` comment after a block comment is still a comment", () => {
  assert.equal(prep("/* a */ SELECT 1 -- gone\nFROM t"), "/* a */ SELECT 1 FROM t");
});
check("`/*` inside a `--` comment does not open a block: the next line is not swallowed (the near-miss)", () => {
  assert.equal(prep("SELECT 1 -- see /* here\nFROM t"), "SELECT 1 FROM t");
});
check("`/*` inside a string literal or quoted identifier is text, not a block comment (the near-miss)", () => {
  assert.equal(prep(`SELECT ${Q}/*${Q}, 1 -- gone\nFROM t`), `SELECT ${Q}/*${Q}, 1 FROM t`);
  assert.equal(prep('SELECT "a/*b" -- gone\nFROM t'), 'SELECT "a/*b" FROM t');
});
check("a block comment with no `--` in it is left alone, whitespace collapsed", () => {
  assert.equal(prep("/* a  b */ SELECT   1"), "/* a b */ SELECT 1");
});

console.log("expect rows: compiles to a DO block");
const compile = (line) => parsePlan(`<TestPlan>\ntarget: cloud\n1. ${line}\n</TestPlan>`).plans[0].steps[0].actions;
const sqlOf = (line) => compile(line)[0].sql;
const BLOCK = (neg, q, msg) => `DO $doctest$ BEGIN IF ${neg}EXISTS (${q}\n) THEN RAISE EXCEPTION '${msg}'; END IF; END $doctest$;`;

check("`expect rows:` raises when the query returns nothing", () => {
  assert.equal(sqlOf("expect rows: SELECT 1 FROM pg_class"), BLOCK("NOT ", "SELECT 1 FROM pg_class", "expected at least one row, got none"));
});
check("`expect no rows:` is the opposite polarity, with its own message (the control for the one above)", () => {
  assert.equal(sqlOf("expect no rows: SELECT 1 WHERE false"), BLOCK("", "SELECT 1 WHERE false", "expected no rows, but the query returned some"));
});
check("it is one action, run as SQL, flagged as an assertion", () => {
  const a = compile("expect rows: SELECT 1");
  assert.equal(a.length, 1);
  assert.equal(a[0].action, "run_sql");
  assert.equal(a[0].assertion, true);
});
check("the verb is not case-sensitive", () => {
  assert.equal(sqlOf("EXPECT NO ROWS: SELECT 1"), sqlOf("expect no rows: SELECT 1"));
});
check("a query wrapped in backticks reaches the database without them (the bug that read like a docs bug)", () => {
  assert.equal(sqlOf("expect rows: `SELECT 1 FROM pg_class`"), sqlOf("expect rows: SELECT 1 FROM pg_class"));
  assert.ok(!sqlOf("expect rows: `SELECT 1`").includes("`"));
});
check("one trailing semicolon is dropped, since the query sits inside EXISTS (...)", () => {
  assert.equal(sqlOf("expect rows: SELECT 1;"), sqlOf("expect rows: SELECT 1"));
  // a space before the semicolon stays, as a harmless space before `)`: the semicolon is what must go
  assert.ok(sqlOf("expect rows: `SELECT 1 ;  `").includes("EXISTS (SELECT 1 \n) THEN"));
  assert.ok(!sqlOf("expect rows: `SELECT 1 ;  `").includes(";)") && !sqlOf("expect rows: `SELECT 1 ;  `").includes("1 ;"));
});
check("a query in the continuation lines is carried, one line each", () => {
  const p = parsePlan("<TestPlan>\ntarget: cloud\n1. expect rows:\n     SELECT 1\n       FROM t;\n</TestPlan>").plans[0];
  assert.equal(p.steps[0].actions[0].sql, BLOCK("NOT ", "SELECT 1\nFROM t", "expected at least one row, got none"));
});
check("a query inside the block is not rewritten: its own quotes and operators survive", () => {
  const q = "SELECT 1 FROM t WHERE name = 'a''b' AND n > 3";
  assert.ok(sqlOf(`expect rows: ${q}`).includes(`EXISTS (${q}\n)`));
});
check("a `-- comment` on the LAST line of the query ends at a newline, so it cannot take the closing parenthesis", () => {
  // psql ends a `--` comment only at a newline. Run against a real Postgres, the one-line form
  // `EXISTS (SELECT 1 -- why) THEN ...` is "mismatched parentheses at end of input".
  const sql = sqlOf("expect rows: SELECT 1 -- why");
  assert.ok(sql.includes("(SELECT 1 -- why\n) THEN RAISE"), sql);
  assert.ok(sqlOf("expect no rows: SELECT 1 WHERE false -- why").includes("-- why\n) THEN RAISE"));
});
check("a comment on an earlier line of a multi-line query is unchanged by that (the control for the one above)", () => {
  const p = parsePlan("<TestPlan>\ntarget: cloud\n1. expect rows:\n     SELECT 1 -- why\n       FROM t;\n</TestPlan>").plans[0];
  assert.equal(p.steps[0].actions[0].sql, BLOCK("NOT ", "SELECT 1 -- why\nFROM t", "expected at least one row, got none"));
});

console.log("describeEditorMismatch: say where the editor text diverges");
check("extra characters at the end are named, with the position and what came before them", () => {
  const m = mism("SELECT f(1);", "SELECT f(1);))");
  assert.match(m, /2 extra characters? at the end/);
  assert.ok(m.includes("))"), m);
});
check("a change in the middle shows both sides around the first difference", () => {
  const m = mism("SELECT 'a''b' FROM t", "SELECT 'a'b' FROM t");
  assert.match(m, /position 11/);
  assert.ok(m.includes("a''b") && m.includes("a'b"), m);
});
check("text that stops early is reported as missing, and whitespace differences alone are not a difference", () => {
  assert.match(mism("SELECT 1 FROM t", "SELECT 1"), /missing/);
  assert.equal(mism("SELECT  1\n FROM t", "SELECT 1 FROM t"), "");
});

console.log(failed ? `\n${failed} check(s) failed` : "\nall checks passed");
process.exit(failed ? 1 : 0);
