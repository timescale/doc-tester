---
status: accepted
---

# Install-guide runs execute the guide verbatim, answering the prompts the plan declares

An install-guide run (see `CONTEXT.md`) exists to catch the guide drifting from reality, so the commands it runs must be the commands a reader runs. The Ubuntu guide has steps no non-interactive runner can execute as written: `sudo apt install …` has no `-y`, `sudo timescaledb-tune` prompts, `sudo -u postgres psql` opens a shell, and `\password postgres` is a psql meta-command sitting inside a `bash` fence that psql reads from the TTY. SSM send-command has no TTY.

We run the guide's commands **verbatim on a pty** (`lib/pty-driver.py`, shipped to the box with each command that declares answers. It is Python stdlib only: `expect` drove the same steps in the feasibility check, but it is a package the guide never asked for, and python3 is already on the cloud images because cloud-init needs it). The prompts a reader sees and the answers they'd type are declared in the plan as explicit prompt/answer pairs, the same way a Console plan declares `confirm \`…\`` instead of the page narrating a dialog. Matching is a deterministic text match, no LLM. A prompt that never appears, or an unexpected one nobody answered, fails the step: that is the drift being caught. Commands run as the AMI's default non-root user with passwordless sudo, so a step where the guide forgot a `sudo` fails here the way it fails for a reader. The pre-installed EC2 target stays root, and existing self-hosted plans don't change.

This is the same rule `lib/fidelity.mjs` already states for the Console: a plan that takes a path no reader would take makes its green meaningless, and a legitimate asymmetry is declared in the grammar, never substituted silently.

**Fallback, taken only on evidence.** If driving prompts proves too flaky in the Ubuntu spike, we fall back to a small fixed rewrite list (`-y`, `--yes`, the psql shell plus `\password` becoming one `run SQL:` step), with every rewritten step flagged in the report, and the test is relabelled honestly as "happy path on a fresh box, non-interactive". That is a deliberate, documented downgrade. This ADR is amended, not quietly bypassed, if it happens.

**Considered and rejected:**

- *Verbatim only, interactive steps skipped and marked unverified.* Honest, but it leaves the last four steps of every distro (the tune, the shell, the password, the connection) untested, and those are the steps that set up what the reader connects to.
- *Plan authors write whatever works.* This is what `infra/templates/user-data.sh.tpl` does today: it adds `-y`/`--yes`, runs as root, and replaces the guide's last two steps with `ALTER ROLE … PASSWORD`. Fine for provisioning a box; wrong for testing the guide, and nothing compares it to the page.

**What this closes, and what it doesn't.** Closed: the prompt flow itself, `\password` as written, a `-y` swallowing a prompt a reader would see, and a missing `sudo`. Still open, by design: OS version branches in the guide (one version per distro is tested) and the guide's warning about pre-existing Postgres installs (this is a fresh-box test). The report states these.

**Consequences.**

- The grammar gains a prompt/answer construct. The verb set is fixed on purpose, so this is a deliberate extension, designed by example in the spike.
- The pty transcript can contain a typed password (the Terraform-generated one, via `<PASSWORD>`) if a prompt echoes it, so the driver redacts it and the walker reports only the plan's own text (`<PASSWORD>`, never the filled value); reports are attachable to PRs.
- The existing statement checks in `lib/fidelity.mjs` have to learn the install guide's own commands. They compare SQL and a whitelist of client commands, and only flag near-misses, so `apt`, the repo setup and `systemctl` are invisible to them today. For a bare-target plan the check becomes plain equality over every command in the page's shell fences, with no rewrite list to account for. Prompt/answer lines are excluded, like `confirm`. *Done in ADR 0010, which also settles scope (the reader's path, not the whole page) and how a plan declares a command it does not run.*
- **Observed in a feasibility check (2026-10-14).** Run on the pre-installed box with stand-in commands, so these are properties of the harness, not evidence for the contract; that came from the bare-box spike below.
  - *Prompts depend on box state.* apt only asks "Do you want to continue?" when an install pulls in extra dependencies, so a declared prompt means "answer if it appears", and the failure is an undeclared prompt that does. That failure surfaces as an idle timeout, so the timer must reset on output or a slow step reads like a hung prompt.
  - *Authors need the exact prompt text, and ANSI-tolerant matching.* `timescaledb-tune` asks `[(y)es/(n)o]:` in colour codes, not `(y/n)`.
  - *Transcripts need processing before they reach a report:* `\r` progress repaints, ANSI codes, and SSM truncates long output.
- **Observed on the bare-box spike (2026-10-14).** The real Ubuntu guide, verbatim, as the default user on a fresh bare box, through `test-page`: 28 steps, all green, with the apt prompts, the pgdg script, all seven `timescaledb-tune` prompts, `\password` in a real psql shell and an interactive `CREATE EXTENSION` / `\dx` session. Three one-line variants each failed for the intended reason: a typo'd package name, a declared prompt whose text is wrong (the stall names the real prompt), and a step missing its `sudo`. The fallback was not needed, which is why this ADR is accepted. Only Ubuntu has run: the other distros change the default user, the SSM-agent question and the guide's own prompts, and a distro where driving prompts proves unworkable amends this ADR rather than quietly bypassing it.
  - *A prompt can repeat, and how often depends on the box.* `timescaledb-tune` asks `Is this okay? [(y)es/(s)kip/(q)uit]:` once per settings category that needs changes (four times here, and not at all on a box that is already tuned). A reader answers it every time, so the grammar has `answer … with … each time`; without it a fixed list of one-shot answers stalls.
  - *A fresh box asks more than a tuned one.* `timescaledb-tune` asked a third prompt (`Is this okay? [(y)es/(n)o]:`, for `shared_preload_libraries`) that the pre-installed box never showed. The undeclared prompt stalled the step and the failure named it, which is the contract working.
  - *A bare Enter needs a spelling.* "Press Enter to continue" (the pgdg script) has no text to type, so the reply is `<Enter>`.
- Cloud-init drift from the Ubuntu partial may stop mattering. Cloud-init still provisions the pre-installed target, so it only goes away if that script stops mirroring the guide; decide that once the bare target exists.

Related: ADR 0004 (explicit, never inferred), ADR 0006 (headers declare how a plan runs).
