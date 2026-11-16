#!/usr/bin/env node
// Self-check for lib/pty-driver.py: node scripts/check-pty-driver.mjs   (exit 1 if anything fails)
//
// Runs the driver locally against small fake interactive scripts, so the prompt/answer logic can be
// changed without provisioning a box. Needs python3 and bash, like the box does (docs/adr/0007).
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const DRIVER = join(dirname(fileURLToPath(import.meta.url)), "..", "lib", "pty-driver.py");
const dir = mkdtempSync(join(tmpdir(), "pty-driver-"));
let failed = 0;
const check = (name, ok, detail = "") => { console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : `\n      ${detail}`}`); if (!ok) failed++; };

function run(script, spec) {
  writeFileSync(join(dir, "s.sh"), script);
  writeFileSync(join(dir, "spec.json"), JSON.stringify(spec));
  const t0 = Date.now();
  const r = spawnSync("python3", [DRIVER, join(dir, "s.sh"), join(dir, "spec.json")], { encoding: "utf8" });
  const lines = r.stdout.trimEnd().split("\n");
  const meta = JSON.parse(lines.pop().replace("@@doctest-pty@@ ", ""));
  return { out: lines.join("\n"), meta, secs: (Date.now() - t0) / 1000, status: r.status };
}

// The shape of the real steps: a colour-wrapped prompt, a silent password prompt, and the SAME
// prompt twice in a row with a different answer each time (psql's `postgres=#`).
const full = run(
  `printf 'Reading package lists... 0%%\\rReading package lists... 100%%\\n'
printf '\\033[35;1mTune it? [(y)es/(n)o]: \\033[0m'; read a; echo "got:$a"
printf 'Enter new password: '; read -s pw; echo; echo "pw-len:\${#pw}"
printf 'postgres=# '; read -r l1; echo "cmd1:$l1"
printf 'postgres=# '; read -r l2; echo "cmd2:$l2"`,
  { idle: 5, answers: [
    { prompt: "Tune it? [(y)es/(n)o]:", reply: "y" },
    { prompt: "Enter new password:", reply: "s3cret" },
    { prompt: "postgres=#", reply: "\\password" },
    { prompt: "postgres=#", reply: "\\q" },
  ] },
);
check("answers four prompts in order, exit 0", full.meta.exit === 0 && full.meta.answered.length === 4 && !full.meta.not_asked.length, JSON.stringify(full.meta));
check("typed text reached the script (colour-wrapped prompt, silent prompt, same prompt twice)", /got:y/.test(full.out) && /pw-len:6/.test(full.out) && /cmd1:\\password/.test(full.out) && /cmd2:\\q/.test(full.out), full.out);
check("transcript has no colour codes or \\r, and a progress bar collapses to its last paint", !/\x1b|\r/.test(full.out) && /100%/.test(full.out) && !/\.\.\. 0%/.test(full.out), JSON.stringify(full.out));

// A key press (`raw`) is typed without the Enter a typed answer gets: Ctrl-D ends input at the prompt, and a
// stray CR after it would be read by whatever reads next. The second `read` below sees that CR as an empty
// line (second:0) if one followed, and sees end-of-file again (second:1) if none did.
const eof = run(`printf 'psql> '; read -r l; echo "first:$?"; read -r -t 2 m; echo "second:$?"`, { idle: 8, answers: [{ prompt: "psql>", reply: "\x04", raw: true, shown: "<Ctrl-D>" }] });
check("a raw reply (Ctrl-D) ends input and is not followed by Enter", eof.meta.exit === 0 && /first:1/.test(eof.out) && /second:1/.test(eof.out), JSON.stringify(eof.out) + JSON.stringify(eof.meta));
const noeof = run(`printf 'psql> '; cat > /dev/null; echo done`, { idle: 2, answers: [] });
check("control: with no Ctrl-D answer the session sits at its prompt and the idle timeout fails the step (124)", noeof.meta.exit === 124, JSON.stringify(noeof.meta));

const stuck = run(`printf 'Surprise? [y/N] '; read a; echo "got:$a"`, { idle: 2, answers: [] });
check("a prompt nothing declared stalls, then fails with exit 124 naming the prompt", stuck.meta.exit === 124 && /Surprise\?/.test(stuck.meta.reason), JSON.stringify(stuck.meta));

const wrong = run(`printf 'Do you want to continue? [Y/n] '; read a; echo "got:$a"`, { idle: 2, answers: [{ prompt: "Proceed with install? [y/N]", reply: "y" }] });
check("a declared prompt whose text is wrong fails the same way (the drift case)", wrong.meta.exit === 124 && /Do you want to continue/.test(wrong.meta.reason), JSON.stringify(wrong.meta));

const optional = run(`echo "installed without asking"`, { idle: 5, answers: [{ prompt: "Do you want to continue? [Y/n]", reply: "Y" }] });
check("a declared prompt that never appears is reported as not asked, not a failure", optional.meta.exit === 0 && optional.meta.not_asked.length === 1, JSON.stringify(optional.meta));

const echoed = run(`printf 'Password: '; read pw; echo "you typed $pw"`, { idle: 5, answers: [{ prompt: "Password:", reply: "hunter2" }], redact: ["hunter2"] });
check("a secret the terminal echoes back is redacted from the transcript", !/hunter2/.test(echoed.out) && /\*\*\*/.test(echoed.out), echoed.out);

const each = run(
  `for c in memory parallelism wal; do printf "$c settings. Is this okay? [(y)es/(s)kip/(q)uit]: "; read -r a; echo "$c:$a"; done`,
  { idle: 5, answers: [{ prompt: "Is this okay? [(y)es/(s)kip/(q)uit]:", reply: "y", each: true }] },
);
check("an `each` answer is typed every time its prompt appears (a count that depends on the box)", each.meta.exit === 0 && each.meta.answered.length === 3 && /wal:y/.test(each.out) && !each.meta.not_asked.length, JSON.stringify(each.meta));
const eachNone = run(`echo "already tuned"`, { idle: 5, answers: [{ prompt: "Is this okay?", reply: "y", each: true }] });
check("an `each` answer that never appears is reported as not asked", eachNone.meta.exit === 0 && eachNone.meta.not_asked.length === 1, JSON.stringify(eachNone.meta));
const once = run(`for i in 1 2; do printf "Continue? "; read -r a; echo "$i:$a"; done`, { idle: 2, answers: [{ prompt: "Continue?", reply: "y" }] });
check("without `each` a prompt is answered once, so a second ask stalls and fails", once.meta.exit === 124 && once.meta.answered.length === 1, JSON.stringify(once.meta));

const bar = run(`printf 'Setting up tree ...\\n\\0337\\033[24;0f\\033[42mProgress: [ 62%%]\\033[49m [####....]\\0338\\nProcessing triggers\\n'`, { idle: 5, answers: [] });
check("dpkg's status bar (save/restore cursor) does not leak into the transcript", !/Progress: \[/.test(bar.out) && /Processing triggers/.test(bar.out) && !/\x1b/.test(bar.out), JSON.stringify(bar.out));

check("the script's exit status is the driver's", run(`exit 3`, { idle: 5, answers: [] }).meta.exit === 3);

const chatty = run(`for i in 1 2 3 4; do echo "download $i"; sleep 1; done`, { idle: 2, answers: [] });
check("steady output resets the idle clock, so a slow step is not a hung prompt", chatty.meta.exit === 0, JSON.stringify(chatty.meta));

const bg = run(`sleep 8 & echo started`, { idle: 30, answers: [] });
check("a background process holding the pty does not hang the run", bg.meta.exit === 0 && bg.secs < 5, `${bg.secs}s ${JSON.stringify(bg.meta)}`);

console.log(failed ? `\n${failed} check(s) failed` : "\nall checks passed");
process.exit(failed ? 1 : 0);
