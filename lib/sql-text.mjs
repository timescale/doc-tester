// SQL text helpers shared by the runner and the linter. Nothing here touches a browser, so
// scripts/lint-plan.mjs can import it without dragging Playwright in.

// Remove `--` comments, but only where `--` really starts one. Inside a string literal or a quoted
// identifier it is ordinary text, so this scans the statement instead of running a regex over it:
// `SELECT '--'` and `VALUES ('a--b')` have to survive intact. Doubled quotes ('' and "") are escapes
// within their own literal, not the end of it. A `/* block comment */` is kept as written, nested ones
// included (Postgres nests them), and what is inside it is not scanned: a `--` there is comment text.
export function stripSqlLineComments(sql) {
  let out = "";
  let quote = null;
  for (let i = 0; i < sql.length; i++) {
    const c = sql[i];
    if (quote) {
      out += c;
      if (c === quote) {
        if (sql[i + 1] === quote) out += sql[++i];
        else quote = null;
      }
      continue;
    }
    if (c === "'" || c === '"') {
      quote = c;
      out += c;
      continue;
    }
    if (c === "/" && sql[i + 1] === "*") {
      let depth = 0;
      do {
        if (sql[i] === "/" && sql[i + 1] === "*") { depth++; out += "/*"; i += 2; }
        else if (sql[i] === "*" && sql[i + 1] === "/") { depth--; out += "*/"; i += 2; }
        else out += sql[i++];
      } while (depth > 0 && i < sql.length);
      i--; // the for loop steps past the last character
      continue;
    }
    if (c === "-" && sql[i + 1] === "-") {
      while (i < sql.length && sql[i] !== "\n") i++;
      // Keep the newline the comment sat on. The collapse turns it into a space; dropping it would
      // weld the tokens either side of the comment together.
      out += "\n";
      continue;
    }
    out += c;
  }
  return out;
}

// Collapse runs of whitespace to one space, EXCEPT inside a string literal or a quoted identifier,
// where whitespace is part of the value: `'two  spaces'` has to reach the database as written (#141).
// A line break inside one cannot be carried, because the editor write is one line so that it can be
// read back (#36). That is refused with a message and not changed to a space, since the statement would
// run with a different value and a check on it could pass or fail for the wrong reason.
// Scans the same way stripSqlLineComments does: doubled quotes escape, and a quote inside a
// `/* block comment */` is comment text (whitespace there collapses like any other).
export function collapseSqlWhitespace(sql) {
  let out = "";
  let quote = null;
  let depth = 0; // open /* comments */
  for (let i = 0; i < sql.length; i++) {
    const c = sql[i];
    if (quote) {
      if (c === "\n" || c === "\r") {
        const near = sql.slice(Math.max(0, i - 30), i).replace(/\s+/g, " ");
        throw new Error(`a line break inside a string literal (…${near}) cannot be typed into the one-line SQL editor, so the statement was not run`);
      }
      out += c;
      if (c === quote) {
        if (sql[i + 1] === quote) out += sql[++i];
        else quote = null;
      }
      continue;
    }
    if (c === "/" && sql[i + 1] === "*") { depth++; out += "/*"; i++; continue; }
    if (depth && c === "*" && sql[i + 1] === "/") { depth--; out += "*/"; i++; continue; }
    if (!depth && (c === "'" || c === '"')) { quote = c; out += c; continue; }
    if (/\s/.test(c)) {
      if (!out.endsWith(" ")) out += " ";
      continue;
    }
    out += c;
  }
  return out.trim();
}

// Says where the text a SQL editor holds departs from the text that was typed into it, or returns ""
// when they match once whitespace is normalised (the same compare the write is verified with). The
// refusal used to quote only the first 60 characters, which is no help when the difference is at the
// end (#152: Monaco appended `))`).
export function describeEditorMismatch(wanted, seen) {
  const norm = (v) => String(v).replace(/\s+/g, " ").trim();
  const w = norm(wanted);
  const s = norm(seen);
  if (w === s) return "";
  let i = 0;
  while (i < w.length && i < s.length && w[i] === s[i]) i++;
  const around = (t) => JSON.stringify(t.slice(Math.max(0, i - 20), i + 20));
  if (i === w.length) return `${s.length - i} extra character${s.length - i === 1 ? "" : "s"} at the end: ${JSON.stringify(s.slice(i))}`;
  if (i === s.length) return `${w.length - i} character${w.length - i === 1 ? "" : "s"} missing from the end: ${JSON.stringify(w.slice(i))}`;
  return `first difference at position ${i + 1}: typed ${around(w)}, editor ${around(s)}`;
}
