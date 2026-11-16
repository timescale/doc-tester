---
status: accepted
---

# A bare plan is checked against the reader's path in the real guide

An install-guide run (see `CONTEXT.md`) is only evidence about the guide if the plan runs the guide's commands. ADR 0007 made the run verbatim and ADR 0008 gave every distro a plan, but both left the plan as a hand copy: the six dev fixtures were written by reading the real partials, and nothing compared them afterwards. The fixtures cannot be compared either, because they are synthetic pages with no fences. The existing checks in `lib/fidelity.mjs` do not help: they read the whole page, match fuzzily (similarity of 0.6 or more), and only know the statements a whitelist (`SHELL_SHAPE`) names, so `apt`, the repo setup and `systemctl` are invisible to them, and on an install page that nests six distros in tabs the other five distros' fences would read as missing.

We hold a `machine: bare` plan on a real page to an exact contract, and check it before anything is provisioned.

**Where the plan lives.** On the real page, not in a sidecar file in this repo. The real docs repo already works this way for about forty pages (twelve of them `target: self-hosted`), and `TestPlan.astro` renders nothing, so readers never see a plan. A bare plan is one block per `(target, os)` on `install-timescaledb.mdx`, not one per distro partial as ADR 0008 first said: the page imports the shared "add the extension" steps once, after the nested distro tabs, so no distro partial contains all the steps its plan has to run (ADR 0008 is amended). The install page lives in the docs repo; nothing here writes to it, and the PR that adds the plans is the docs owner's to open and approve.

**What a plan is checked against: the reader's path.** The Linux tab, the plan's distro tab, and the shared steps around them, cut out of the page after its partials are inlined. `os:` maps to the tab's label through a fixed table (`OS_TABS` in `lib/plan.mjs`: `redhat` is "Red Hat", `rocky` is "RockyLinux", `arch` is "ArchLinux"), so no new header line. A label the page no longer has is an error that names it, never a skip: a quiet pass there would bring back the vanished-fences problem. A non-distro tab (Docker, Kubernetes) has no `os:` to name it; how a plan names one is decided in ADR 0011.

**What counts as a command.**
- One logical command out of a `bash`, `sh` or `shell` fence: `\` continuations joined, a heredoc kept through its terminator, a leading `$ ` and comment-only lines dropped. Whitespace is collapsed within a line, and line breaks are kept, because a heredoc is a file.
- Equality is on that text, in the page's order, with no fuzzy matching. The report names guide commands not run, plan commands not on the page, changed commands, and commands run out of order.
- A `<placeholder>` in a guide command matches any non-empty text in the plan's command, because the reader substitutes too (`psql -d "postgres://<username>:<password>@<host>:<port>/<database-name>"` is run with the box's values). A command that is nothing but a placeholder, such as `<database-name>` in prose, matches only itself.
- A plan command may also trace to an inline-code span, or to a line of a `sql` fence, which is what a reader types at a psql prompt. Neither is *required*: inline code in prose is not always a command, and a `sql` fence also holds sample output. RHEL's `sudo dnf -qy module disable postgresql` is inline code in a callout, which is why this exists. The check runs from plan to page, so no guess is needed about which spans are commands.
- A line typed at a psql prompt (`answer \`postgres=#\` with \`DROP DATABASE prod;\``) is a command and is checked like a `run command:`. A reply to any other prompt (`y`, `<Enter>`, a password) is the declared grammar of ADR 0007 and is not.
- Only fences tagged `bash`, `sh` or `shell` are read. A command the page gives in an untagged fence is reported, not required (*see ADR 0011*).
- `run SQL:` and `expect rows:` are out of scope: the SQL checks in `fidelity.mjs` own them.

**How a plan leaves a guide command out: a `skip` verb.** `skip \`<command>\`: <reason>` is the only way to omit a guide command, and the lint reports a skip whose command is no longer on the page, or that the plan also runs. `lib/plan.mjs` had explicitly refused a `skip` verb, because "three honest skips and four silent omissions read as equally complete". Under this lint an omission can only be declared, so none is silent, and that objection no longer holds. The verb is legal only in a `machine: bare` plan (a parse error elsewhere), and the walker reports it as skipped, never as a pass. The live example is Ubuntu's `wget … | sudo apt-key add -` under "For Ubuntu 21.10 and earlier": one version per distro is tested (ADR 0007), so that branch is declared, not silent.

**The plan on a real page is the guide verbatim, and goes red on a guide bug.** Debian and Fedora fail on a stock image because of what the guide says. Their dev fixtures carry one labelled workaround step each; the plan on the real page does not. The lint is clean and the *run* fails, which is the finding. No verb declares "the guide is wrong here".

**Fixtures are not linted, by path.** A `DOCS_REPO` inside `dev-fixtures/` is fixture mode: the check is skipped and the report says "guide fidelity not checked". There is no frontmatter marker to forge or forget, and a real checkout always gets the full check. The cost is that a copy of a fixture kept outside `dev-fixtures/` is treated as the real docs and refused.

**`test-page` refuses before it provisions.** A bare plan on a real page is checked once the run units are known and before `apply()`; drift exits 2 with the findings, like a grammar error, and no box is created. `lint-plan` reports the same findings. For a bare block it no longer runs the whole-page fuzzy drift, out-of-order and "statement not run" checks, which the strict check replaces and which read a two-line fence as one statement and cannot see an `answer`; `procedure not covered` stays.

**Considered and rejected:**

- *A sidecar plan with a `mirrors:` line naming the real partial.* Keeps the docs repo untouched, but adds a mapping concept nothing else in the docs repo uses, and the plan is then never next to the guide it describes.
- *Warn on a guide command the plan did not run.* Cheap, and lets a plan drop `systemctl restart postgresql` and lint clean, which is the bug this exists to catch.
- *Leave it red.* Ubuntu's 21.10 branch could then never be clean on a single-version run.
- *A grammar line declaring a known guide deviation.* The verb set is fixed on purpose, and a workaround kept in the plan would make a docs bug invisible once it was written down.
- *Treat every fence as a command.* The `sql` fence holding `\dx`'s sample output would be a command the plan has to run.

**Consequences.**

- The docs repo needs one PR before this means anything in practice: six blocks on `install-timescaledb.mdx`, and a `TestPlan.astro` grammar header that mentions `machine:`, `os:`, `answer` and `skip`, none of which it does today. Until then only the dev fixtures run, and their green is "my copy works".
- Adding a distro is now also a row in `OS_TABS`.
- **A plan goes stale when someone edits the page's commands, and nothing flags it until the tool runs.** Docs CI runs nothing on a `<TestPlan>` (checked 2026-10-15), so Tiger-Data-Docs #461 (drop the `yum update` step) would leave the Red Hat, Fedora and Rocky plans reporting "command not on page" with no signal in the PR. It fails loudly when the tool does run (`lint-plan` reports it, `test-page` refuses with exit 2 before provisioning), so it is never a false green, but it is also never automatic. Wiring `lint-plan` into docs CI is deferred on purpose: the lint needs only files, but who carries this tool's checkout in the docs repo is undecided.
- Out of scope, by design: other tabs (Docker and Kubernetes are designed in ADR 0011; macOS and Windows are not planned), OS version branches (one version per distro, as in ADR 0007, now declared with `skip`), the twelve older self-hosted plans (they keep the fuzzy checks), and docs CI.

Related: ADR 0006 (headers declare how a plan runs), ADR 0007 (verbatim), ADR 0008 (one block per distro).
