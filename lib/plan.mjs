// Parse the <TestPlan> block a docs page carries and turn its Steps into actions walk.mjs can run.
//
// A plan is the same flow as the page, written for a bot: it names the same controls, and spells out
// the mechanical steps a human is never told (dismissing a confirmation dialog, for one). It is NOT
// graded against the prose. A failing step means something on the page is wrong, and the matching
// doc step is easy to find by hand.
//
// Why a plan at all, rather than tokenizing the prose: reader-facing prose does not
// and should not say what a test needs. It cannot say "run procedure 1 first", which
// tiger-cloud-essentials silently requires (its tiering step needs a continuous aggregate that an
// earlier procedure creates). It cannot say "these two tabs are alternatives, undo the first before
// trying the second", which is why that page's second variant failed on "already exists". And it
// cannot name a safe email address to demote. Those are facts about the test run, and a per-step
// annotation could not express the first two at all.
//
// Determinism is preserved: no LLM reads a plan at run time. The verb set below is fixed, and a line
// that matches none of it is reported, never skipped — a documented instruction that vanishes
// silently is the failure mode this tool has been bitten by most often.

// Does an action mutate? This decides whether the walker refuses it on the standing service. These
// moved here verbatim from the deleted prose extractor, which was their only other user. Do not
// `copy` covers psql's `\COPY`, which loads a file into a table and was reading as HARMLESS: on the
// standing service the gate would have let tiger-cloud-essentials ingest its million-row sample into
// a real table instead of refusing the step.
//
// restate them anywhere else: an earlier draft of this file kept its own copy of SQL_MUT that lacked
// `_policy\s*\(`, so `SELECT add_tiering_policy(...)` read as harmless and would have run against
// the standing service instead of a fork.
// `terminate` joined the list for the Connections page's `Terminate connection`: it kills a live
// session, and off a fork that session could be a real user's.
const DESTRUCTIVE = /\b(create|delete|remove|apply|change|terminate)\b/i;
const SQL_MUT = /\b(insert|update|delete|drop|create|alter|truncate|grant|revoke|reindex|vacuum|merge|call|copy)\b|refresh\s+materialized|_policy\s*\(|enable_columnstore|disable_columnstore|convert_to_(columnstore|rowstore)|(de)?compress|add_(retention|compression|columnstore|continuous)|remove_(retention|compression|columnstore)/i;

// A plan is ONLY a numbered list. There are no sections.
//
// Isolation, Setup, Inputs and Notes were headings once, and each was a step wearing a heading: the
// parser read three words out of thirty-five lines of prose. Worse, a heading HID work from the
// report. Fetching the dataset a page tells the reader to unzip is a documented instruction that can
// fail on a moved asset or a dead link; as a Setup line it was invisible to the run and to coverage,
// and as `download <url>` it passes or fails like any other step.
//
// So `fork the service` and `download <url>` are verbs, there is one grammar for the whole plan, and
// every line is countable. Prose that is not a numbered step is commentary and is ignored.
//
// There is no `skip` verb for a Console or pre-installed plan: a route the plan does not test simply
// has no steps. A declared skip records only what an author remembered to declare, so three honest
// skips and four silent omissions read as equally complete, and nothing can check that a skip's
// reason is still true. Limits of the WALKER (a cross-origin iframe it cannot drive) belong in
// CLAUDE.md once, not on every page.
//
// The one exception is a `machine: bare` plan (docs/adr/0010). Its lint holds the plan to every
// command in the reader's path, so an omission can only be declared and none is silent, and the lint
// checks that a skipped command is still on the page.

// Every <TestPlan> block on the page, in document order. Non-greedy so a stray later mention can't
// swallow the document, and tolerant of attributes even though the component takes none — a plan
// that grew a prop should be reported as unparsed rather than disappearing.
//
// More than one block per page is allowed (docs/adr/0006): a page whose procedures diverge by
// product writes one block per product, and a page that imports a Console-only partial's plan adds
// its own self-hosted block beside the import. Each block then has to say which product it covers.
const BLOCK = /<TestPlan\b[^>]*>([\s\S]*?)<\/TestPlan>/g;

// The products a plan can run on, in the order a multi-target run walks them. The name is what an
// author writes in `target:` and in a step prefix; `product` is the frontmatter spelling it answers
// for. A new substrate is a row here plus a provisioner and a walker; the grammar does not change.
// Frontmatter also knows `mst` and (later) `enterprise`, which have no substrate: a plan naming one
// is a parse error, and a page tagged with one shows as "not covered" rather than silently passing.
export const TARGETS = [
  { name: "cloud", product: "cloud", label: "Tiger Cloud" },
  { name: "self-hosted", product: "self_hosted", label: "self-hosted TimescaleDB" },
];
const TARGET_NAMES = TARGETS.map((t) => t.name);
export const productToTarget = (product) => TARGETS.find((t) => t.product === product)?.name ?? null;

// `target: cloud, self-hosted` — the products this block runs on. One line, before the first step.
// Absent means `cloud`, so every plan written before this line existed keeps its meaning.
const TARGET_LINE = /^\s*targets?\s*:\s*(.*\S)\s*$/i;

// `machine: bare` — the self-hosted box has only the OS, and the plan's own steps are what install
// the database (an install-guide run, docs/adr/0007). One line, before step 1, like `target:`.
// Absent means `preinstalled`, the cloud-init box every self-hosted plan has run on so far, so no
// plan written before this line existed changes meaning. Explicit, never inferred from the page
// (docs/adr/0004).
const MACHINE_LINE = /^\s*machine\s*:\s*(.*\S)\s*$/i;
const MACHINES = ["preinstalled", "bare"];

// `os: ubuntu` — which distro a bare plan runs on (docs/adr/0008). Legal only with `machine: bare`
// (the pre-installed box is Ubuntu-only) and required with it (no default to infer, docs/adr/0004).
// A distro is a name here, a default user in lib/ec2.mjs and an AMI in infra/; the grammar does not change.
const OS_LINE = /^\s*os\s*:\s*(.*\S)\s*$/i;
export const OSES = ["ubuntu", "debian", "rocky", "fedora", "redhat", "arch"];

// The tab a reader picks under "Linux" on the install page, for each distro: what a bare plan is
// checked against is that tab plus the shared steps around it (docs/adr/0010). A distro is a row
// here too, and a label the page no longer has is an error in the lint, never a skip.
export const OS_TABS = { ubuntu: "Ubuntu", debian: "Debian", redhat: "Red Hat", fedora: "Fedora", rocky: "RockyLinux", arch: "ArchLinux" };

// `path: docker-ha` — which part of the install page a bare plan is checked against (docs/adr/0011).
// `os:` names the box and `path:` names the reader's path, because a Docker plan runs on an Ubuntu box
// and reads the Docker tab. A key is a row in PATHS, never free text (docs/adr/0004): a typo is a
// parse error, and a label the page no longer has is an error in the lint. Absent means the distro's
// own path, Linux then `OS_TABS[os]`, so a plan written before this line existed does not change.
const PATH_LINE = /^\s*path\s*:\s*(.*\S)\s*$/i;
export const PATHS = {
  "docker-ha": ["Docker", "TimescaleDB-HA"],
  "docker-light": ["Docker", "TimescaleDB light"],
  kubernetes: ["Kubernetes"],
};

// `needs: docker, psql` — what the guide says you need before its first step and does not script
// (docs/adr/0011). The harness installs each over SSM before step 1 and the report lists what it
// installed, so a guide that forgets to install something a reader needs still fails: a distro plan
// declares nothing. Declared, never inferred from the page's prose (docs/adr/0004), legal only with
// `machine: bare`. A token names what a reader would have installed; the value is the distros the
// harness can provide it on, and the installer for each is in lib/prerequisites.mjs.
const NEEDS_LINE = /^\s*needs\s*:\s*(.*\S)\s*$/i;
export const NEEDS = { docker: ["ubuntu"], psql: ["ubuntu"], kubernetes: ["ubuntu"] };

// The tab labels a block's reader's path chooses, outermost first, or null for a block with no `os:`.
export const pathLabels = (block) => (block.path ? PATHS[block.path] : block.os ? ["Linux", OS_TABS[block.os]] : null);

// `[self-hosted] run command: …` — a step that runs on one of the block's targets only. The names
// inside the brackets are the same words as in `target:`. `[resolve: …]` is a different bracket and
// is left to its own verb.
const STEP_PREFIX = /^\[(?!resolve\s*:)([^\]]*)\]\s*/i;

// Verbs that mean the same thing on every substrate, so a two-target plan may leave them
// unprefixed: SQL goes through psql on both sides, `fork the service` is a throwaway copy on both,
// and a download lands on the machine running the test either way. Everything else — Console verbs,
// and `run command`, which runs on the tester's laptop for Cloud and on the box as root for EC2 —
// only has a meaning on one side and must say which (docs/adr/0006).
const SHARED_ACTIONS = new Set(["run_sql", "fork_service", "download", "unparsed"]);

// NUMBERED lines only. A plan is an ordered script, so a step always has a number — and accepting
// bullets too meant the explanatory list at the end of a plan ("Not scripted, and why: - ...") was
// read as three more steps the moment the section above it stopped absorbing them. Prose belongs in
// the notes section, which is not executed.
const STEP_LINE = /^\s*\d+[.)]\s+(.*\S)\s*$/;

// ---------------------------------------------------------------------------
// Verb set. Each returns an array of actions, or null if it does not apply.
// Shapes match what walk.mjs dispatches on, so no new arms are needed there.
// ---------------------------------------------------------------------------

const BT = "`([^`]+)`"; // a backticked label

// A plan lives inside MDX, so its text is parsed as MDX — and an angle-bracket placeholder like
// `<database-name>` in a documented connection string reads as an unclosed JSX tag and FAILS THE
// BUILD. The page's own copy of that command is protected by a code fence; a plan step is not.
// Wrapping a statement in backticks makes it inline code, which MDX leaves alone, so a plan may
// write `run command: \`psql -d "postgres://<user>@<host>/<db>"\`` and this strips them back off.
const unwrapCode = (s) => s.trim().replace(/^`+|`+$/g, "").trim();
// Lines without the indent they all share, trailing space dropped.
const dedent = (lines) => {
  const lead = (s) => s.match(/^[ \t]*/)[0].length;
  const common = Math.min(...lines.map(lead));
  return lines.map((l) => l.slice(common).trimEnd()).join("\n");
};

// "click `X` in `Group`" — one option out of a group of identically-labelled ones.
//
// The continuous-aggregate wizard's refresh-policy step is why this exists: `End offset` and
// `Schedule interval` offer the SAME four options (3/6/12/24 hours), so a bare "click `3 hours`"
// takes the first match and silently sets the wrong field — and then overwrites the value the
// previous step just set. Nothing downstream would notice, because the aggregate still gets created.
function clickIn(line) {
  const m = line.match(new RegExp(`^click\\s+${BT}\\s+in\\s+${BT}\\s*$`, "i"));
  if (!m) return null;
  return [{ action: "click", label: m[1], after: m[2] }];
}

// "click tab `Hypertables`" — name the KIND of control, when a label is ambiguous.
//
// The Explorer's aggregates panel has an inner tab called `Hypertables` and the sidebar beside it an
// object-type filter button of the same name. clickLabel tries roles in a fixed order with button
// first, so the filter won: the run filtered the sidebar, never left the aggregates panel, and then
// reported 13 consecutive failures hunting for a wizard entry that only exists on the other tab. One
// wrong control, thirteen wrong findings.
//
// The plan says which one it means rather than the tool guessing better. Roles are the ones
// clickLabel already searches, so this narrows an existing rung instead of adding a mechanism.
function clickRole(line) {
  const m = line.match(new RegExp(`^click\\s+(tab|button|link|menuitem)\\s+${BT}\\s*$`, "i"));
  if (!m) return null;
  return [{ action: "click", label: m[2], role: m[1].toLowerCase(), destructive: DESTRUCTIVE.test(m[2]) || undefined }];
}

// "confirm `Let's go!`" — the button on a confirmation dialog.
//
// A separate verb rather than a plain click, for two reasons.
//
// It is the ONE press a page is not expected to document. A reader looking at "You are about to
// enable tiered storage" can see the button and does not need telling; the bot cannot, and needs the
// step. That asymmetry is legitimate, so lib/fidelity.mjs skips these steps when it checks that a
// plan presses only the controls the page names. Written as a click, every confirm dialog in every
// plan would read as divergence, which is what made an earlier version of that check unusable.
//
// And saying "this is a confirm" is a claim the walker can CHECK: it requires a dialog to be open
// before pressing, so a plan whose earlier step failed to open one fails here instead of quietly
// pressing something else on the page.
function confirmDialog(line) {
  const m = line.match(new RegExp(`^confirm\\s+${BT}\\s*$`, "i"));
  if (!m) return null;
  return [{ action: "confirm", label: m[1], destructive: DESTRUCTIVE.test(m[1]) || undefined }];
}

// "click `A` > `B` > `C`" — a path through nav or menus becomes one click per hop, which is what the
// walker does for the same construct in prose.
function clickPath(line) {
  const m = line.match(new RegExp(`^click\\s+${BT}((?:\\s*>\\s*${BT})*)\\s*$`, "i"));
  if (!m) return null;
  const labels = [m[1], ...[...m[2].matchAll(/`([^`]+)`/g)].map((x) => x[1])];
  return labels.map((label) => ({
    action: "click",
    label,
    destructive: DESTRUCTIVE.test(label) || undefined,
  }));
}

// "toggle `X` on" / "toggle `X`" / "toggle `X` on for `row`" — desired state is optional; without it
// the walker flips it. The trailing "for `row`" picks one row out of a table of identical controls:
// the CSV upload's column mapping has a `Hypertable partition` switch per column and the docs say
// which column ("Enable `Hypertable partition` for the `time` column"), so the plan has to say it too.
function toggle(line) {
  const m = line.match(new RegExp(`^toggle\\s+${BT}(?:\\s+(on|off))?(?:\\s+for\\s+${BT})?\\s*$`, "i"));
  if (!m) return null;
  return [{ action: "toggle", label: m[1], desired: m[2] ? m[2].toLowerCase() === "on" : undefined, row: m[3] || undefined }];
}

// "type `value` into `Field`" — the walker decides where to type; the field name is kept for the
// report and for the provenance check, not for targeting.
//
// "type $INVITE_EMAIL into `Email`" names an env-backed value instead: the plan carries the name,
// the value lives in DOCTEST_INPUT_INVITE_EMAIL. Plans are committed to a public docs repo, so a
// real mailbox, CIDR or credential name must never appear in one, and some of these values have to
// be an address the run actually controls, which no docs page can supply.
//
// Not extended to service or project ids. `select the service` and `fork the service` mean whichever
// service the run is about, and the id comes from the tool: an id in a plan rots the next time a
// standing service is recreated, and points a run at a service nobody looked at.
function type(line) {
  const m = line.match(new RegExp(`^type\\s+(?:${BT}|\\$([A-Z][A-Z0-9_]{2,}))(?:\\s+into\\s+${BT})?\\s*$`, "i"));
  if (!m) return null;
  if (m[2]) return [{ action: "type_input", name: m[2], field: m[3] || undefined }];
  return [{ action: "type", text: m[1], field: m[3] || undefined }];
}

// "run SQL: <statement>" — the statement itself, on the step line or in the lines indented under it.
//
// Written out rather than pointed at one of the page's fences by index. Indexing was worse on every
// count: "step 7" meant the seventh SQL FENCE, not the seventh documented step, so it read as a lie;
// adding a fence anywhere earlier silently shifted every later reference onto the wrong statement;
// and a reader of the plan could not tell what a step did without counting fences. It also sat oddly
// beside the labels, which have always been written out (click `Data Tiering`, not "the third label").
//
// The trade this accepts: the run now exercises the plan's copy of a statement, not the page's, so a
// syntax error in a fence a plan does not quote goes uncaught. Acceptable because the plan is the
// bot-facing variant of the same flow, maintained beside the prose by the same person in one pass.
function inlineSql(line) {
  const m = line.match(/^run\s+sql\s*:\s*([\s\S]+)$/i);
  if (!m) return null;
  const sql = unwrapCode(m[1]);
  return [{ action: "run_sql", sql, destructive: SQL_MUT.test(sql) || undefined }];
}

// "replace the statement with:" + the statement on the lines below — for a wizard that pre-fills a
// code editor and documents an edit to it.
//
// The continuous-aggregate wizard writes a CREATE MATERIALIZED VIEW for you and the page tells the
// reader to paste its own version over it before running. Without this the plan clicked straight
// through to `Run and proceed`, so the wizard's generated statement ran and the page's statement — the
// one a reader actually copies — was never executed by anything.
//
// Distinct from `type` because it is a code editor, not a field: the contents have to be selected and
// cleared first, and the value is multi-line.
function replaceStatement(line) {
  const m = line.match(/^replace\s+the\s+statement\s+with\s*:\s*([\s\S]+)$/i);
  if (!m) return null;
  const sql = unwrapCode(m[1]);
  return [{ action: "replace_statement", sql, destructive: SQL_MUT.test(sql) || undefined }];
}

// "run command: psql ..." — same reasoning as inlineSql. Placeholders the docs leave open
// (<username>, <password>, a whole connection URI) are still resolved from the environment at run
// time by walk.mjs's resolveCommand, so a plan quotes the documented form, not real credentials.
function inlineCommand(line) {
  const m = line.match(/^run\s+command\s*:\s*([\s\S]+)$/i);
  return m ? [{ action: "run_shell", command: unwrapCode(m[1]) }] : null;
}

// "answer `Do you want to continue? [Y/n]` with `Y`" — what a reader types at a prompt the
// `run command:` above it raises (docs/adr/0007). A separate numbered step, like `confirm` on the
// Console: the asymmetry between a bot and a reader is declared in the plan, never substituted into
// the command. parseBlock attaches it to the nearest preceding `run command:`, which then runs on a
// pty. The prompt is plain text as printed (colour codes are stripped before matching); the reply
// may carry `<PASSWORD>` or a `$NAME` input like any other command, and `<Enter>` is a bare Enter. A trailing `each time` answers every time the prompt appears,
// not just the first: timescaledb-tune asks once per settings category that needs changes, and how
// many that is depends on the box.
function answerPrompt(line) {
  const m = line.match(new RegExp(`^answer\\s+${BT}\\s+with\\s+${BT}(\\s+each\\s+time)?\\s*$`, "i"));
  return m ? [{ action: "answer", prompt: m[1], reply: m[2], each: m[3] ? true : undefined }] : null;
}

// "expect output contains `timescaledb`" — what the guide says a reader sees, checked against the
// transcript of the `run command:` above it, once that command has exited (docs/adr/0011). A plain
// case-sensitive substring, never a regex: a pattern in a docs plan is a trap, and "the list shows
// timescaledb" is all the Docker guide promises. The lint ties the text to the page.
function expectOutput(line) {
  const m = line.match(/^expect\s+output\s+contains\s+`([^`]+)`$/i);
  return m ? [{ action: "expect_output", text: m[1] }] : null;
}

// Replies to `answer` that are a key press, not text a reader types: no command for the lint to find on
// the page. `<Enter>` is a bare Enter; `<Ctrl-D>` is end-of-file, which is how a reader walks away from
// a psql session the guide never tells them to leave (docs/adr/0011).
export const KEY_REPLY = /^<(?:Enter|Ctrl-D)>$/;

// "skip `sudo apt-key add -`: Ubuntu 21.10 and earlier only" — a command the guide gives that this
// bare plan does not run, and why (docs/adr/0010). The only way to leave a guide command out: the
// lint reports every other omission, and reports a skip whose command is no longer on the page.
function skipCommand(line) {
  const m = line.match(new RegExp(`^skip\\s+${BT}\\s*:\\s*(\\S[\\s\\S]*)$`, "i"));
  return m ? [{ action: "skip_command", command: m[1].trim(), reason: m[2].trim() }] : null;
}

// "wait up to 90s for postgres in container `timescaledb`" — the seconds a reader spends between
// `docker run -d` and the next command, which a bot does not (docs/adr/0011). Not a delay and not a
// retry: it polls the one thing a reader would see ready, and fails with the container's own log if
// the limit passes or the container dies first. The name is checked against the page by the lint.
// "... in pod `timescaledb-0`" is the same for a Kubernetes pod. A pod is Ready before its postgres
// is up, so this form polls postgres and does not use the Ready condition.
export const WAIT_MAX_SECONDS = 600;
// "wait up to 120s for pod `test-pod` ready" — the Kubernetes Ready condition, for a pod that runs no
// postgres (docs/adr/0011). It says Ready because that is all it checks; the postgres form says postgres.
function waitForPodReady(line) {
  const m = line.match(/^wait\s+up\s+to\s+(\d+)\s*s\s+for\s+pod\s+`([a-z0-9][a-z0-9.-]*)`\s+ready$/i);
  return m && /^[a-z0-9][a-z0-9.-]*$/.test(m[2]) ? [{ action: "wait_pod_ready", seconds: Number(m[1]), pod: m[2] }] : null;
}
function waitForPostgres(line) {
  const m = line.match(/^wait\s+up\s+to\s+(\d+)\s*s\s+for\s+postgres\s+in\s+(container|pod)\s+`([A-Za-z0-9][\w.-]*)`$/i);
  if (!m) return null;
  const [seconds, kind, name] = [Number(m[1]), m[2].toLowerCase(), m[3]];
  // A pod's name is a Kubernetes name: lowercase, so `Timescaledb-0` is no pod and is unparsed, not a wait.
  if (kind === "pod") return /^[a-z0-9][a-z0-9.-]*$/.test(name) ? [{ action: "wait_postgres", seconds, pod: name }] : null;
  return [{ action: "wait_postgres", seconds, container: name }];
}

// "select the service" — navigate to the service under test.
function selectService(line) {
  return /^select\s+(?:the\s+)?service\b/i.test(line) ? [{ action: "select_service" }] : null;
}

// "go to /operations/resources" — reach a page by URL instead of by clicking to it.
//
// POSITIONING, not a test. The distinction matters: navigating by URL proves nothing about the nav
// labels the docs promise, so it must never replace a documented click chain. What it is for is
// getting into a known state, and RESETTING one. A linear plan accumulates page state that separate
// procedures never shared — on tiger-cloud-essentials the SQL Editor panel, expanded by fourteen
// SQL steps, covered the bottom half of the High availability form, so the submit control could not
// be reached and the radio options behind it could not be picked. A fresh load clears that.
//
// The path is relative to the service under test, so a plan never hardcodes a project or service id.
function goTo(line) {
  const m = line.match(/^go\s+to\s+(\/[\w\-/]*)\s*$/i);
  return m ? [{ action: "goto", path: m[1] }] : null;
}

// "expect url /explorer/data-tiering" — assert the page we ended up on, after a documented click
// chain. This is what makes a nav step's pass mean "it navigated" rather than "the label existed":
// clicking `Data Tiering` succeeded on this page for a run in which nothing had verified that the
// click went anywhere.
function expectUrl(line) {
  const m = line.match(/^expect\s+url\s+(\S+)\s*$/i);
  return m ? [{ action: "expect_url", fragment: m[1] }] : null;
}

// "expect label `Meeting policy`" / "expect label $INVITE_EMAIL" — assert that text is ON the page.
//
// The assertion of last resort, for state with no catalog and no URL behind it: high-availability
// configuration, which neither SQL nor `tiger service get` exposes, and project members, where there
// is no SQL at all and an invited address in the table is the only evidence the invitation happened.
//
// $NAME reads DOCTEST_INPUT_NAME, so a plan can assert on the address it invited without publishing
// one. "expect no label" is the other half, for removal flows that could otherwise only report that
// the buttons were clickable.
function expectLabel(line) {
  const m = line.match(new RegExp(`^expect\\s+(no\\s+)?label\\s+(?:${BT}|\\$([A-Z][A-Z0-9_]{2,}))\\s*$`, "i"));
  if (!m) return null;
  return [{ action: "expect_label", absent: !!m[1] || undefined, label: m[2] || undefined, name: m[3] || undefined }];
}

// "expect enabled `Transfer project ownership`" — assert a control is present AND usable.
//
// The other half of `expect label`, which passes on a greyed-out control: it asks getByText, so a
// disabled menu item reads exactly like a working one. That is fine when the thing asserted is STATE
// the app renders as text, which is what `expect label` is mostly for, and wrong when the thing
// asserted is a control a reader is told to press. The transfer-ownership section says so itself —
// "if you are unable to transfer ownership, hover over the greyed out button".
//
// Absent and disabled are reported as DIFFERENT failures. Collapsing them would repeat the mistake
// this tool keeps making: `isLabelDisabled` answers false both when nothing matched and when
// something enabled matched, so an assertion built on it would pass on a control that is not there.
function expectEnabled(line) {
  const m = line.match(new RegExp(`^expect\\s+enabled\\s+${BT}\\s*$`, "i"));
  if (!m) return null;
  return [{ action: "expect_enabled", label: m[1] }];
}

// "dismiss" — close an open menu or dialog without choosing anything.
//
// What makes it possible to test a destructive procedure up to its last click and stop: open the row
// menu, assert `Leave project` is there and usable, and leave without pressing it. Without this the
// menu stays open and the next step acts on a page it covers — the same modal-blocks-everything
// failure the undocumented resend dialog caused.
//
// Fails when nothing is open, for the reason `confirm` does: the verb claims something is open, and
// a claim the walker can check is worth more than a keypress that always "succeeds". A plan whose
// menu-opening step silently did nothing fails here instead of passing three meaningless steps.
function dismiss(line) {
  return /^dismiss\s*$/i.test(line) ? [{ action: "dismiss" }] : null;
}

// "choose an unselected option" — a step where the docs deliberately leave the choice open ("Choose
// your replication strategy, then click `Change configuration`"). Any valid choice works, so that is
// good docs rather than a gap, but the submit control stays disabled until something actually
// changes. Stating it as its own step makes the plan explicit and resolves the choice BEFORE the
// submit, instead of relying on the walker noticing a disabled click and recovering.
function chooseOption(line) {
  return /^choose\s+(?:an?\s+)?(?:unselected|different|other)\s+option\s*$/i.test(line)
    ? [{ action: "choose_option" }]
    : null;
}

// "edit a parameter value" — the Database parameters grid, where the page leaves the parameter and
// its new value open ("hover over the value you want to change and click the edit icon").
//
// The walker has driven this grid since the extractor days (editParameterValue: hover the first
// numeric value cell, press its edit button, fill an in-range value, blur to save), but no plan verb
// reached it after plans replaced the extractor, so the customize-configuration page could not be
// scripted at all. The edit icon has no label a page could name, which is exactly the kind of control
// a verb exists for.
function editParameterValue(line) {
  if (/^edit\s+(?:a|the)\s+parameter\s+value\s*$/i.test(line)) return [{ action: "edit_parameter_value" }];
  // "edit `max_standby_streaming_delay`": the same grid, for a page that names the parameter
  // (read scaling's "Adjust `max_standby_streaming_delay` and `max_standby_archive_delay`").
  const named = line.match(/^edit\s+`([a-z_][a-z0-9_.]*)`\s*$/i);
  return named ? [{ action: "edit_parameter_value", param: named[1] }] : null;
}

// "select another option in the dropdown" — a drop-down whose value the page leaves open.
//
// The members page says "select another role in the dropdown" and names no role, deliberately: any
// role other than the current one demonstrates the procedure. Naming one in the plan would press a
// control the page does not name, which the fidelity check reports, and would also pick a role for a
// real person.
//
// Distinct from `choose an unselected option`, which drives RADIOS. Same intent, different control,
// and a plan that confuses them gets "no dropdown found" on a page full of radio buttons.
//
// The walker restores the original value when the run ends, because the page says the change commits
// immediately and this runs against a real member of a real project.
//
// "select another option in `Severity type`" names WHICH drop-down, for a page with several. The
// Monitoring pages put three or four filters in a row (Logs: two date pickers and a severity list;
// Insights: a time range, a query-type list and a threshold), and "the dropdown" would be whichever
// one the resolver met first. The name is the caption the Console prints above the control, or the
// value it shows when it has no caption (the Jobs timeline's `Last 24 hours`), and the fidelity check
// grades it like any other pressed label, so the page has to name it too.
function selectOtherOption(line) {
  const m = line.match(new RegExp(`^select\\s+(?:another|a\\s+different)\\s+option\\s+in\\s+(?:the\\s+dropdown|${BT})\\s*$`, "i"));
  if (!m) return null;
  return [{ action: "select_other_option", field: m[1] || undefined }];
}

// "type the value the dialog asks for" — a confirmation that demands a value only the dialog knows.
//
// `Terminate connection` opens 'Type "686" to confirm', and 686 is the connection's PID: it exists
// only at run time, so a plan cannot carry it, `type` needs its text up front, and a $NAME input comes
// from the environment, which has never heard of this connection either. The walker reads the demanded
// value off the open dialog and types it into the dialog's one field. Never page-wide: outside a
// dialog nothing is asking for anything, and guessing a field is how a table name once landed in the
// SQL editor.
function typeDialogValue(line) {
  return /^type\s+the\s+value\s+the\s+dialog\s+asks\s+for\s*$/i.test(line) ? [{ action: "type_dialog_value" }] : null;
}

// "expect rows: <query>" / "expect no rows: <query>" — assert what a query returns.
//
// Needed because `run SQL:` only fails when the statement ERRORS: a SELECT over an empty table
// succeeds, so a plan could walk an entire ingest route, load nothing, and pass. These conditions
// used to sit in an **Assert** section that nothing executed, which read as verification while
// verifying nothing. Assertions are steps now.
//
// Compiled into a DO block that raises rather than into a row count. Row counts would have to be
// scraped out of the Console's result panel and parsed out of psql's output separately; an exception
// is already a failure on both paths, so there is one mechanism instead of two.
function expectRows(line) {
  const m = line.match(/^expect\s+(no\s+)?rows\s*:\s*([\s\S]+)$/i);
  if (!m) return null;
  const none = !!m[1];
  // unwrapCode for the same reason `run SQL:` needs it: a long statement in a plan gets wrapped in
  // backticks so MDX leaves it alone, and an assertion is the longest statement in most plans. Both
  // of tiger-cloud-essentials' policy assertions were wrapped, and both reached the database with the
  // backticks still on: `syntax error at or near "`"`. They failed as assertions, which reads exactly
  // like the docs being wrong, so a plan-side quoting rule looked like a product bug.
  const query = unwrapCode(m[2]).replace(/;\s*$/, "");
  const message = none ? "expected no rows, but the query returned some" : "expected at least one row, got none";
  const sql =
    // The newline before `)` is for a query ending in `-- comment`: psql ends a comment only at a newline,
    // so on one line the comment would swallow the parenthesis (#142).
    `DO $doctest$ BEGIN IF ${none ? "" : "NOT "}EXISTS (${query}\n) THEN ` +
    `RAISE EXCEPTION '${message}'; END IF; END $doctest$;`;
  return [{ action: "run_sql", sql, assertion: true }];
}

// "expect error: <statement>" / "expect error containing `text`: <statement>" — assert that a
// statement the page says must fail does fail.
//
// Pages state failure modes in prose: "you get an error if you partition by a column that is not in
// the unique index", "unique constraints must include the time column". `run SQL:` cannot carry them,
// because it passes only when a statement succeeds, so every documented failure was a blank in the
// claims table, and nothing noticed when the product started accepting what the page said it rejects.
//
// Compiled into a DO block like `expect rows:`, so both walkers and the dry run need nothing new: the
// statement runs through EXECUTE inside a sub-block, an error there is caught and recorded, and the
// block raises when no error came, or when `containing` names text the message does not have. EXECUTE
// rather than the statement inline, because a bare SELECT inside PL/pgSQL is itself an error ("query
// has no destination"), which would make a succeeding SELECT look like the failure the plan expected.
// The same DO-block limit as `expect rows:` applies: a statement that cannot run inside a function
// (CREATE DATABASE, VACUUM, CREATE INDEX CONCURRENTLY) cannot be asserted this way.
function expectError(line) {
  const m = line.match(/^expect\s+error(?:\s+containing\s+`([^`]+)`)?\s*:\s*([\s\S]+)$/i);
  if (!m) return null;
  const statement = unwrapCode(m[2]).replace(/;\s*$/, "");
  const containing = m[1] ? m[1].trim() : null;
  const tagged = (text, tag) => `$${tag}$${text}$${tag}$`;
  const mention = containing
    ? ` IF position(lower(${tagged(containing, "doctest_t")}) IN lower(SQLERRM)) = 0 THEN ` +
      `RAISE EXCEPTION 'the error was "%", which does not mention "%"', SQLERRM, ${tagged(containing, "doctest_t")}; END IF;`
    : "";
  const sql =
    `DO $doctest$ DECLARE failed boolean := false; BEGIN ` +
    `BEGIN EXECUTE ${tagged(statement, "doctest_q")}; EXCEPTION WHEN OTHERS THEN failed := true;${mention} END; ` +
    `IF NOT failed THEN RAISE EXCEPTION 'expected an error, but the statement succeeded'; END IF; ` +
    `END $doctest$;`;
  return [{ action: "run_sql", sql, assertion: true, expectError: { statement, containing } }];
}

// "upload <filename>" — put a file the page told the reader to download into a file input.
//
// Replaces what would otherwise be a [resolve: dropzone] hint. Naming the file is clearer, and it is
// the only thing the step actually needs to say: the docs' phrasing ("click to browse, or drag and
// drop <local folder>/tutorial_sample_tick.csv") deliberately leaves the folder open, and the folder
// is whatever this run fetched into. Playwright sets a file input directly, so no drag is simulated.
function upload(line) {
  const m = line.match(/^upload\s+([\w.-]+)\s*$/i);
  return m ? [{ action: "upload", file: m[1] }] : null;
}

// "exit psql" — end the psql session, so the SQL after it goes back through the Console editor.
//
// Needed because a session persists across steps by design: a page that connects with psql and then
// runs several statements means for all of them to go that way. But a page can document a psql route
// for ONE section and Console routes for the rest, which is exactly tiger-cloud-essentials — its psql
// tab covers creating the tables, and everything after it is Console. Without an explicit end, the
// later sections would be tested through a route their own text never mentions.
//
// The docs themselves have this step: the major-upgrade page tells the reader to exit psql.
function exitPsql(line) {
  return /^exit\s+psql\s*$/i.test(line) ? [{ action: "exit_psql" }] : null;
}

// "open the first row in the list" — a step where the docs point at live data rather than a label:
// "Click a job ID in the list to view its config and run history" names no job on purpose, because
// which jobs exist depends on the service. The walker resolves it the way a reader would: the first
// row that drills into a direct child of the current path (/monitoring/jobs -> /monitoring/jobs/1009).
// Scoped to the current path so it cannot wander into unrelated navigation. The resolver existed for
// the extractor and no plan verb reached it, so the Jobs procedure could not be scripted at all.
function openFirstRow(line) {
  return /^open\s+the\s+first\s+row(?:\s+in\s+the\s+(?:list|table))?\s*$/i.test(line) ? [{ action: "open_row" }] : null;
}

// "[resolve: dropzone]" — the escape hatch for a control the docs cannot name: a drag-and-drop
// target, a hover-only edit icon, an unlabeled cog. Emitted as its own action so walk.mjs can route
// it to a structural resolver; until one exists for a given hint, it is reported rather than run.
function resolveHint(line) {
  const m = line.match(/^\[resolve:\s*([^\]]+)\]\s*$/i);
  return m ? [{ action: "resolve", hint: m[1].trim() }] : null;
}

// "fork the service" — run everything that follows on a throwaway copy of the standing service.
//
// Was the `**Isolation**: fork` heading, whose only machine-readable content was the word "fork".
// As a step it appears in the report, it is countable, and its ORDER is visible: everything after it
// runs on the fork. Without it a plan runs on the standing service, where destructive steps are
// refused — silence stays the safe default, because a plan that forgot to say so cannot damage
// anything. The fork itself still happens before the walk starts (the walker needs a service to
// drive), so this step is executed by test-page.mjs and reported in place.
//
// It means the same on every target the block declares: a throwaway copy. On Tiger Cloud that is a
// fork of the standing service; on the EC2 target it is a no-op, because every EC2 run is a fresh
// box that is destroyed afterwards (docs/adr/0005). Where a plan runs is the `target:` line's job,
// not this verb's — `fork the self-hosted service` used to carry both meanings and was retired for
// that reason (docs/adr/0006); parsePlan reports it with a pointer at `target:`.
function forkTheService(line) {
  return /^fork\s+(?:the\s+)?service\s*$/i.test(line) ? [{ action: "fork_service" }] : null;
}
const RETIRED_FORK_LINE = /^fork\s+the\s+self-hosted\s+service\s*$/i;

// "download https://..." — fetch what the page tells the reader to download.
//
// Was the `**Setup**: fetch <url>` heading. The page's own first step on tiger-cloud-essentials is
// "Unzip crypto_sample.zip to a <local folder>", and as a heading it had NO step of its own: a moved
// or dead asset — a real, reader-visible docs failure — could not fail the run. Archives are unzipped
// and the directory becomes psql's working directory and the source for any `upload` step; it is
// deleted when the run ends, whether or not the run passed.
function download(line) {
  const m = line.match(/^download\s+(https:\/\/\S+?)[\s,;.]*$/i);
  return m ? [{ action: "download", url: m[1] }] : null;
}

// "open https://whatsmychaincert.com/" — leave the Console for a site the page sends the reader to.
//
// The strict-SSL page's chain-file route runs through a third-party site, and until now that made
// five of its six steps unscriptable. `go to` is service-relative on purpose and stays that way;
// this is the other case, a full URL the page itself names. "navigate to" is accepted because that
// is the page's own wording.
function openUrl(line) {
  const m = line.match(/^(?:open|navigate\s+to)\s+(https:\/\/\S+?)[\s,;.]*$/i);
  return m ? [{ action: "open_url", url: m[1] }] : null;
}

// "paste bundle.crt into the box" / "paste bundle.crt into `Field`" — a file an earlier command wrote,
// typed into a text box. The page says "copy the bundle to your clipboard" and then "paste"; the run
// has no clipboard and does not need one, it reads the file from its own working directory. "the
// box" means the page's only visible text area, and the step fails if there is not exactly one.
function pasteFile(line) {
  const m = line.match(new RegExp(`^paste\\s+([\\w.\\-]+)\\s+into\\s+(?:the\\s+box|${BT})\\s*$`, "i"));
  return m ? [{ action: "paste_file", file: m[1], field: m[2] || undefined }] : null;
}

// "save the download as ~/.postgresql/root.crt" — keep what the last click produced, at the path the
// page names. `~` is the RUN's home directory, a temporary directory that exists for this run only,
// never the account's real one; the documented psql that follows runs with that home, so it finds the
// file where the page says it will be, and nothing outside the run is touched.
function saveDownload(line) {
  const m = line.match(/^save\s+the\s+download\s+(?:as|to)\s+(\S+)\s*$/i);
  return m ? [{ action: "save_download", path: unwrapCode(m[1]) }] : null;
}

const VERBS = [clickRole, clickIn, clickPath, confirmDialog, toggle, type, typeDialogValue, inlineSql, replaceStatement, expectRows, expectError, inlineCommand, answerPrompt, expectOutput, skipCommand, waitForPostgres, waitForPodReady, forkTheService, selectService, download, openUrl, pasteFile, saveDownload, goTo, expectUrl, expectEnabled, expectLabel, chooseOption, selectOtherOption, editParameterValue, openFirstRow, dismiss, exitPsql, upload, resolveHint];

// Parse one step line into actions. A trailing "[resolve: …]" may follow another verb on the same
// line, so it is split off first.
function parseStep(text) {
  const out = [];
  let line = text.trim();

  const tail = line.match(/\s*(\[resolve:[^\]]+\])\s*$/i);
  let trailing = null;
  if (tail) {
    trailing = resolveHint(tail[1]);
    line = line.slice(0, tail.index).trim();
  }

  // A statement is taken whole: splitting on ", then " is for chaining clicks, and SQL or a shell
  // command can legitimately contain that text.
  const whole = /^(?:run\s+(?:sql|command)|replace\s+the\s+statement\s+with)\s*:/i.test(line) || /^(?:answer|skip)\s+`/i.test(line) || /^expect\s+output\s+contains\s+`/i.test(line);
  // Sentences are split on ", then " so "click `A`, then click `B`" works the way an author expects.
  for (const part of whole ? [line] : line.split(/,\s*then\s+/i)) {
    const p = part.trim().replace(/\.$/, "");
    if (!p) continue;
    const got = VERBS.map((f) => f(p)).find(Boolean);
    if (got) out.push(...got);
    // A step carrying a [resolve: …] hint is ALREADY explained by that hint — its leading sentence is
    // the human description of a control the docs cannot name ("Start a CSV upload"), not a missed
    // instruction. Reporting it as unparsed would make the escape hatch noisy exactly where it is
    // meant to be used.
    else if (!trailing) out.push({ action: "unparsed", text: p });
  }
  if (trailing) out.push(...trailing);
  return out;
}

// Parse one <TestPlan> block. `index` is its position on the page, for messages.
function parseBlock(body, index) {
  // Group each numbered line with the indented lines under it, so a step can carry a multi-line body:
  //
  //   5. run SQL:
  //        CREATE MATERIALIZED VIEW assets_candlestick_daily
  //        WITH (timescaledb.continuous) AS ...
  //
  // Continuation rather than a nested fence: a plan lives inside MDX, and a ```sql block nested in a
  // component is asking for trouble from the MDX parser for no gain.
  //
  // Anything not numbered and not indented under a step is commentary. A plan is a list, so this is
  // where a leftover heading or a sentence of context lands, harmlessly. The one commentary line
  // with meaning is `target:`, and only before the first step: after it, it is a step that forgot
  // its number, and silently honouring it there would let a plan change products halfway through.
  const grouped = [];
  const errors = [];
  let targets = null;
  let machine = null;
  let os = null;
  let osWritten = false;
  let path = null;
  let pathWritten = false;
  let needs = null;
  for (const raw of body.split("\n")) {
    const m = raw.match(STEP_LINE);
    if (m) { grouped.push({ text: m[1], body: [], raw: [] }); continue; }
    if (grouped.length && /^\s+\S/.test(raw)) { grouped[grouped.length - 1].body.push(raw.trim()); grouped[grouped.length - 1].raw.push(raw); continue; }
    const mc = raw.match(MACHINE_LINE);
    if (mc) {
      if (grouped.length) errors.push({ detail: `\`machine:\` must come before step 1, not after step ${grouped.length}` });
      else if (machine) errors.push({ detail: "more than one `machine:` line" });
      else if (!MACHINES.includes(mc[1].trim().toLowerCase())) errors.push({ detail: `\`machine: ${mc[1].trim()}\` is not a machine this tool knows (known: ${MACHINES.join(", ")})` });
      else machine = mc[1].trim().toLowerCase();
      continue;
    }
    const oc = raw.match(OS_LINE);
    if (oc) {
      osWritten = true;
      if (grouped.length) errors.push({ detail: `\`os:\` must come before step 1, not after step ${grouped.length}` });
      else if (os) errors.push({ detail: "more than one `os:` line" });
      else if (!OSES.includes(oc[1].trim().toLowerCase())) errors.push({ detail: `\`os: ${oc[1].trim()}\` is not a distro this tool can provision (known: ${OSES.join(", ")})` });
      else os = oc[1].trim().toLowerCase();
      continue;
    }
    const nc = raw.match(NEEDS_LINE);
    if (nc) {
      if (grouped.length) errors.push({ detail: `\`needs:\` must come before step 1, not after step ${grouped.length}` });
      else if (needs) errors.push({ detail: "more than one `needs:` line; list every prerequisite on the one line" });
      else {
        needs = [];
        for (const name of nc[1].split(",").map((x) => x.trim().toLowerCase()).filter(Boolean)) {
          if (!NEEDS[name]) errors.push({ detail: `\`needs: ${name}\` is not a prerequisite this tool can provide (known: ${Object.keys(NEEDS).join(", ")})` });
          else if (needs.includes(name)) errors.push({ detail: `\`needs:\` lists ${name} twice` });
          else needs.push(name);
        }
        if (!needs.length && !errors.length) errors.push({ detail: "`needs:` names no prerequisite" });
      }
      continue;
    }
    const pc = raw.match(PATH_LINE);
    if (pc) {
      pathWritten = true;
      if (grouped.length) errors.push({ detail: `\`path:\` must come before step 1, not after step ${grouped.length}` });
      else if (path) errors.push({ detail: "more than one `path:` line" });
      else if (!PATHS[pc[1].trim().toLowerCase()]) errors.push({ detail: `\`path: ${pc[1].trim()}\` is not a reader's path this tool knows (known: ${Object.keys(PATHS).join(", ")}; a distro's own path is implied by \`os:\`)` });
      else path = pc[1].trim().toLowerCase();
      continue;
    }
    const t = raw.match(TARGET_LINE);
    if (!t) continue;
    if (grouped.length) { errors.push({ detail: `\`target:\` must come before step 1, not after step ${grouped.length}` }); continue; }
    if (targets) { errors.push({ detail: "more than one `target:` line; list every product on the one line" }); continue; }
    targets = [];
    for (const name of t[1].split(",").map((x) => x.trim().toLowerCase()).filter(Boolean)) {
      if (!TARGET_NAMES.includes(name)) errors.push({ detail: `\`target: ${name}\` is not a product this tool can run on (known: ${TARGET_NAMES.join(", ")})` });
      else if (targets.includes(name)) errors.push({ detail: `\`target:\` lists ${name} twice` });
      else targets.push(name);
    }
    if (!targets.length && !errors.length) errors.push({ detail: "`target:` names no product" });
  }
  const declared = !!targets;
  if (!targets?.length) targets = ["cloud"];
  // `bare` describes the self-hosted box; on a plan that never runs there it would be a line that
  // silently does nothing, which is the failure this grammar exists to make loud.
  if (machine === "bare" && !targets.includes("self-hosted")) errors.push({ detail: "`machine: bare` only means something on `target: self-hosted`" });
  // The two `os:` rules (docs/adr/0008): a distro line means nothing on the pre-installed box, and a
  // bare plan that names none would leave the tool guessing which box to build.
  if (os && machine !== "bare") errors.push({ detail: "`os:` only means something with `machine: bare`; the pre-installed box is Ubuntu" });
  // An `os:` that was written but refused already has its error; a second one saying it is missing would mislead.
  if (machine === "bare" && !os && !osWritten) errors.push({ detail: `\`machine: bare\` needs an \`os:\` line naming the distro (known: ${OSES.join(", ")})` });
  // `path:` is the same kind of line as `os:` (docs/adr/0011): it means nothing without a bare box to
  // run on, and a written-but-refused one already has its error.
  if (pathWritten && machine !== "bare") errors.push({ detail: "`path:` only means something with `machine: bare`; it names the part of the install page the plan is checked against" });
  // `needs:` is the same kind of line as `os:` and `path:`: it provisions a bare box, so it means
  // nothing without one, and the harness only has an installer for some distros.
  if (needs && machine !== "bare") errors.push({ detail: "`needs:` only means something with `machine: bare`; the pre-installed box has what its plans need" });
  for (const n of needs || []) if (os && !NEEDS[n].includes(os)) errors.push({ detail: `\`needs: ${n}\` is not provided on ${os} yet (provided on: ${NEEDS[n].join(", ")})` });
  let retired = false;
  const multi = targets.length > 1;
  const skipsAllowed = machine === "bare";

  const steps = [];
  const unparsed = [];
  const inputs = [];
  for (const [idx, { text: rawText, body: cont, raw }] of grouped.entries()) {
    const n = idx + 1;
    // A trailing ":" means the statement is in the continuation lines, not on the step line. A command's
    // lines keep their indentation relative to each other (only the indent they all share is dropped): a
    // heredoc is a file, and in a YAML manifest the indentation is the meaning (docs/adr/0011).
    const body = /^(?:\[[^\]]*\]\s*)?run\s+command\s*:\s*$/i.test(rawText) ? dedent(raw) : cont.join("\n");
    const full = cont.length && /:\s*$/.test(rawText) ? `${rawText} ${body}` : rawText;

    // The product prefix, if any. Validated against THIS block's `target:` line: a prefix naming a
    // product the block does not run on is a step that would never execute, which is the silent
    // omission this tool exists to make loud.
    let stepTargets = targets;
    let text = full;
    const pre = full.match(STEP_PREFIX);
    if (pre) {
      text = full.slice(pre[0].length);
      const names = pre[1].split(",").map((x) => x.trim().toLowerCase()).filter(Boolean);
      const bad = names.filter((x) => !targets.includes(x));
      if (bad.length) errors.push({ step: n, detail: `[${bad.join(", ")}] is not in this block's \`target:\` (${targets.join(", ")})` });
      else if (!multi) errors.push({ step: n, detail: `[${names.join(", ")}] prefix on a single-target plan; drop it, or add the product to \`target:\`` });
      stepTargets = names.filter((x) => targets.includes(x));
      if (!stepTargets.length) stepTargets = targets;
    }

    if (RETIRED_FORK_LINE.test(text)) {
      errors.push({ step: n, detail: "`fork the self-hosted service` is retired: put `target: self-hosted` before step 1, and write `fork the service` (a throwaway copy on every target)" });
      retired = true;
      steps.push({ text: full, actions: [], targets: stepTargets, n });
      continue;
    }

    // "use the row for OWNER_EMAIL" reuses walk.mjs's existing testRow handling: pick the table row
    // holding a value this run owns, rather than whichever row happens to be first.
    const row = text.match(/^(?:act on|use)\s+the\s+row\s+for\s+\$?([A-Z][A-Z0-9_]{2,})\s*$/i);
    if (row) { inputs.push(row[1]); steps.push({ text: full, actions: [], testRow: row[1], targets: stepTargets, n }); continue; }

    const actions = parseStep(text);
    for (const a of actions) if (a.action === "unparsed") unparsed.push(a.text);
    // A declared skip only has a lint behind it on a bare plan (docs/adr/0010); anywhere else it would
    // be the declared-skip bookkeeping this grammar refuses, so it is an error, not a quiet no-op.
    if (!skipsAllowed && actions.some((a) => a.action === "skip_command")) errors.push({ step: n, detail: "`skip` only means something with `machine: bare`: it declares a guide command the plan does not run, and only a bare plan is checked against the guide's commands (docs/adr/0010)" });
    // `wait` polls a container on the box, so like `skip` it only has a meaning where a plan runs the
    // guide's commands on a bare box, and its limit is bounded so a typo cannot hold a box for hours.
    for (const a of actions.filter((x) => x.action === "wait_postgres" || x.action === "wait_pod_ready")) {
      if (machine !== "bare") errors.push({ step: n, detail: "`wait` only means something with `machine: bare`: it waits on a container or pod the plan started on the box" });
      if (a.seconds < 1 || a.seconds > WAIT_MAX_SECONDS) errors.push({ step: n, detail: `\`wait up to ${a.seconds}s\`: the limit is 1 to ${WAIT_MAX_SECONDS} seconds` });
    }
    // In a two-target block, a step that only has a meaning on one side has to say which side. The
    // rule is by verb, not by guesswork about the step: see SHARED_ACTIONS.
    if (multi && !pre) {
      const oneSided = actions.find((a) => !SHARED_ACTIONS.has(a.action));
      if (oneSided) errors.push({ step: n, detail: `\`${oneSided.action.replace(/_/g, " ")}\` only has a meaning on one product; prefix the step with the product it runs on ([${targets.join("] or [")}])` });
    }
    // A statement or command may name an env-backed value the same way a `type` step does. Collected
    // here so the report's input list is what the plan actually reads: a password belongs in
    // DOCTEST_INPUT_*, never in a plan committed to a public docs repo.
    for (const a of actions) {
      for (const m of String(a.sql || a.command || "").matchAll(/\$([A-Z][A-Z0-9_]{2,})/g)) inputs.push(m[1]);
    }
    // Any action naming an env-backed value counts as an input the run uses, so the report's list is
    // what the plan actually reads rather than a section someone maintained by hand.
    for (const a of actions) if (a.name) inputs.push(a.name);

    // An env-backed `type $NAME into `Field`` becomes the step-level testInput the walker already
    // resolves, so there is one code path for a withheld value rather than two.
    const envType = actions.find((a) => a.action === "type_input");
    if (envType) {
      inputs.push(envType.name);
      steps.push({ text: full, actions: actions.filter((a) => a !== envType), testInput: envType.name, targets: stepTargets, n });
      continue;
    }
    steps.push({ text: full, actions, targets: stepTargets, n });
  }

  // An `answer` belongs to the command above it: attach it there, in declared order, so the walker
  // runs that command on a pty with its answers. One with no command above it answers nothing.
  let lastShell = null;
  for (const s of steps) {
    for (const a of s.actions) {
      if (a.action === "run_shell") { lastShell = a; a.answers = a.answers || []; }
      else if (a.action === "answer") {
        if (lastShell) lastShell.answers.push({ prompt: a.prompt, reply: a.reply, each: a.each });
        else errors.push({ step: s.n, detail: "`answer` has no `run command:` above it to answer for" });
      } else if (a.action === "expect_output" && !lastShell) errors.push({ step: s.n, detail: "`expect output contains` has no `run command:` above it to check" });
    }
  }
  for (const s of steps) for (const a of s.actions) if (a.action === "run_shell" && !a.answers.length) delete a.answers;

  const acts = steps.flatMap((s) => s.actions);
  return {
    index,
    targets,
    declared,
    machine: machine || "preinstalled",
    os,
    path,
    needs: needs || [],
    retired,
    steps,
    inputs: [...new Set(inputs)],
    unparsed,
    errors,
    // Derived from the steps, so the orchestration test-page.mjs has to do before the walk is read
    // off the same list a reviewer reads, not out of a heading beside it.
    forkRequested: acts.some((a) => a.action === "fork_service"),
    downloads: acts.filter((a) => a.action === "download").map((a) => a.url),
  };
}

/**
 * Parse the page's plan(s).
 *
 * Returns { present, plans, targets, uncovered, errors, steps, inputs, unparsed, forkRequested,
 * downloads }. `plans` is one entry per <TestPlan> block, each with its own `targets`, `steps`
 * ([{ text, actions, targets, n, testInput?, testRow? }]) and `errors`; `targets` is the union of
 * what the blocks cover, in TARGETS order. `steps`, `inputs`, `unparsed` and `downloads` are the
 * union across blocks, for the checks that look at what the page's plans do as a whole; a run uses
 * planFor() to get one block's view of one target.
 *
 * `errors` is every rule the grammar enforces beyond "this line matched no verb": an unknown
 * product, a prefix the block's `target:` does not cover, an unprefixed one-sided verb in a
 * two-target block, two blocks claiming the same product, a second block with no `target:` of its
 * own, the retired fork line, and a block claiming a product the page's `products:` does not list
 * (when `products` is given). A plan with errors must not run: the plan as written and the plan as
 * executed would differ, and the report would not say so.
 *
 * `uncovered` lists the page's products no block targets. That is coverage information, not an
 * error: it is the state of every plan on a both-tagged page written before `target:` existed.
 *
 * A plan whose block holds no numbered steps is a deliberate "nothing here is testable" — the
 * absence of steps IS the skip. Absence of the whole block means the plan is unwritten, which is a
 * different thing and must stay distinguishable.
 */
export function parsePlan(mdx, { products = null } = {}) {
  const blocks = [...mdx.matchAll(BLOCK)];
  if (!blocks.length) return { present: false, plans: [], targets: [], uncovered: [], errors: [], steps: [], inputs: [], unparsed: [], forkRequested: false, downloads: [] };

  const plans = blocks.map((b, i) => parseBlock(b[1], i + 1));
  const errors = [];
  const seen = new Map();
  for (const plan of plans) {
    for (const e of plan.errors) errors.push({ block: plan.index, ...e });
    if (plans.length > 1 && !plan.declared) errors.push({ block: plan.index, detail: "a page with more than one <TestPlan> needs a `target:` line on each block" });
    // One block per (target, os, path) (docs/adr/0008, 0011): a bare plan is written once per distro,
    // and a Docker block and a distro block can share a distro.
    for (const t of plan.targets) {
      const key = `${t}|${plan.os || ""}|${plan.path || ""}`;
      if (seen.has(key)) errors.push({ block: plan.index, detail: `targets ${t}${plan.os ? ` on ${plan.os}` : ""}${plan.path ? ` (${plan.path})` : ""}, which block ${seen.get(key)} already covers; one block per ${plan.os ? "product, distro and path" : "product"}` });
      else seen.set(key, plan.index);
    }
  }
  const targets = TARGET_NAMES.filter((t) => plans.some((p) => p.targets.includes(t)));

  // The page's claim, against the plan's. A block may not claim more than the page does; a page may
  // claim more than its blocks cover, and that gap is reported, not failed.
  let uncovered = [];
  if (products?.length) {
    const page = products.map((p) => ({ product: p, target: productToTarget(p) }));
    for (const plan of plans) {
      // A block still on the retired fork line has no `target:` yet; its implied `cloud` is not a
      // claim the author made, so do not report it against the page's products as well.
      if (plan.retired && !plan.declared) continue;
      for (const t of plan.targets) {
        if (!page.some((p) => p.target === t)) errors.push({ block: plan.index, detail: `targets ${t}, but the page's \`products:\` (${products.join(", ")}) does not list it` });
      }
    }
    uncovered = page.filter((p) => !p.target || !plans.some((pl) => pl.targets.includes(p.target))).map((p) => ({ product: p.product, target: p.target }));
  }

  return {
    present: true,
    plans,
    targets,
    uncovered,
    errors,
    steps: plans.flatMap((p) => p.steps.map((s) => ({ ...s, block: p.index }))),
    inputs: [...new Set(plans.flatMap((p) => p.inputs))],
    unparsed: plans.flatMap((p) => p.unparsed),
    forkRequested: plans.some((p) => p.forkRequested),
    downloads: [...new Set(plans.flatMap((p) => p.downloads))],
  };
}

/**
 * The (target, block) pairs a run walks (docs/adr/0008), each on its own box. `wanted` narrows the
 * products and `osWanted` the bare blocks to the distros named; a unit either leaves out is in
 * `allUnits` but not `units`, so the caller can report it as "not run", never a pass. Shared by
 * test-page and test-batch so a batch's `--dry-run` counts exactly what the children will run.
 */
export function runUnits(parsed, wanted = null, osWanted = null) {
  const selected = TARGETS.map((t) => t.name).filter((t) => parsed.targets.includes(t) && (!wanted || wanted.includes(t)));
  const allUnits = selected.flatMap((t) => parsed.plans.filter((b) => b.targets.includes(t)).map((b) => ({ target: t, block: b.index, os: t === "self-hosted" ? b.os : null, path: t === "self-hosted" ? b.path : null })));
  const units = allUnits.filter((u) => !osWanted || (u.os && osWanted.includes(u.os)));
  return { selected, allUnits, units };
}

/**
 * One target's view of the page's plans: the block that covers `target`, with every step kept at
 * its number and the steps for other products left in place with nothing to do. Numbering has to
 * survive, because `--from 12` and the report both mean step 12 as written. Returns null when no
 * block covers the target.
 */
export function planFor(parsed, target, block = null) {
  // Several blocks can cover the same target once a bare plan is written per distro (docs/adr/0008),
  // so a run unit names its block; asking by target alone gets the first, as it always did.
  const plan = block ? parsed.plans.find((p) => p.index === block && p.targets.includes(target)) : parsed.plans.find((p) => p.targets.includes(target));
  if (!plan) return null;
  return {
    ...plan,
    target,
    steps: plan.steps.map((s) => (s.targets.includes(target) ? s : { ...s, actions: [], testInput: undefined, testRow: undefined, otherTarget: s.targets.join(", ") })),
  };
}
