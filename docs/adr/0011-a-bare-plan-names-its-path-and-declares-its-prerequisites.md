---
status: accepted
---

# A bare plan names its path, declares its prerequisites, and waits as a reader would

ADR 0008 gave every Linux distro a plan, and ADR 0010 checks each against the reader's path. Both assumed the path is "Linux, then the distro tab", and that the only thing a bare box needs is an OS. The install page's Docker and Kubernetes tabs break both: they are top-level tabs (Docker has three sub-tabs, one with no commands at all), their guides say "you need Docker and psql" or "a cluster and kubectl" without scripting either, and a human's typing latency hides readiness races that a bot at machine speed hits.

## The reader's path

**`os:` names the box, and a `path:` line names the reader's path.** `os:` used to do both jobs, through `OS_TABS`. A Docker plan runs on an Ubuntu box and reads the Docker tab, so the jobs split. `path:` takes a key from a fixed table (`docker-ha`, `docker-light`, `kubernetes`), each mapping to a list of tab labels (`["Docker", "TimescaleDB-HA"]`). Absent means `["Linux", OS_TABS[os]]`, so a distro plan needs no `path:` line. The line is called `path:`, not `tab:`, because it names the reader's path (`CONTEXT.md`), and for a distro that is two labels. It is legal only with `machine: bare`, like `os:`. A label the page no longer has is an error, never a skip (ADR 0010).

**A run unit is `(target, os, path)`.** A Docker block and an Ubuntu block both run on Ubuntu, so a result row cannot be keyed by distro alone. This amends ADR 0008's "one row per `(target, os)`". `--os` still narrows by distro.

**Docker has a block per sub-tab that has commands.** `TimescaleDB-HA` and `TimescaleDB light` are the same shape with different images, one block each. `Chainguard` has no commands, so it is "nothing to test", listed and not failed. Under ADR 0010 every shell-fence command on a path is run or `skip`ped, including a variant that reuses the container name of an earlier step, which needs `skip` because it conflicts with that step.

## Prerequisites

**A plan declares its prerequisites with `needs:`, and the harness provides them.** A prerequisite (`CONTEXT.md`) is something the guide says you need and does not script. The tokens are `docker`, `psql` and `kubernetes` (a self-managed cluster plus `kubectl`, which a reader counts as one thing), each provided on Ubuntu only. The harness installs each over SSM after boot and before step 1, using the thing's own official installer, and the report lists what was installed with its version. A distro plan declares nothing, so its box stays bare and a distro guide that forgets the client still fails (the Debian guide installs `postgresql-client-18` itself, and that is worth keeping testable). The Docker the harness installs must work for the box's default user without `sudo`, because a Docker that needs `sudo` is not one a reader would call working. `needs:` is declared, never inferred from the page's prose (ADR 0004), is legal only with `machine: bare`, and is not checked against the page's prerequisite prose, which is not deterministically extractable.

**Kubernetes runs on k3s on the same bare Ubuntu box, not a managed cluster.** The guide's prerequisite text lists "Self-managed Kubernetes" first, the commands under test (`kubectl create namespace`, the PVC, the StatefulSet, the secret) are core API calls that do not depend on the cluster being managed, and a managed cluster means widening `docs-tester`'s policy (ADR 0003), a reaper for a forgotten cluster (ADR 0005 deliberately has none), and 20 to 45 minutes a run. A managed cluster is taken only on evidence, if a drift appears that k3s cannot reproduce. The honest cost: the storage class, load balancers and image-pull behaviour differ from a managed cluster, and the guide's PVC uses the default storage class.

**`needs: kubernetes` provides a cluster the reader's `kubectl` can reach.** `lib/prerequisites.mjs` installs k3s from its stable channel, with a downloaded installer (`curl | sh -` would run an empty script, and succeed, when the download fails), then the upstream `kubectl` at the server's version with its sha256 checked, replacing k3s's symlink by rename, and puts the kubeconfig in the default user's `~/.kube/config`. The probe, as that user, waits for a Ready node, and the report lists `k3s vX, kubectl vX`. A probe is a script file run as the default user, because a `$(...)` inside a `bash -c "<string>"` is expanded by the shell that receives it.

**The kubeconfig is a prerequisite, not a guide gap.** The page's "a cluster" and "kubectl for command-line interaction with your cluster" are one prerequisite, so the connection between them comes with it. A turnkey-cloud reader gets theirs from the provider.

**A folder the guide never says to create is a guide gap, not a prerequisite.** A guide whose `docker run -v <folder>:/pgdata` fails on a folder that does not exist goes red there, and `wait` says why at once with the container's log. Providing the folder with a `needs:` token was rejected: it would turn the plan green over a guide bug and hide it from anyone who reads only a green row. The cost is that the steps after it never run against the real page until the docs say to create the folder, so their coverage lives in a dev fixture.

## Waiting

**A plan models reader latency with a `wait` verb, not a retry and not a pause.** A person takes seconds between `docker run -d` and `psql`; the container needs that long to accept connections. A bot would get `connection refused` and the run would go red for a reason no reader would see. The verb is fixed-vocabulary and names its subject and its limit. The limit is in the verb, 1 to 600 seconds, with no default. `wait` is bare-only. A name with a space, a pure delay (`wait 15s`) and a retry do not parse, so they are reported `unparsed` like any unknown line. The limit is counted in one-second sleeps, with probe time on top, so a wait is never shorter than its limit. A `wait` that runs out of time fails the step, with the probe's last output, and the report shows how long each one waited.

There are three forms:

- ``wait up to Ns for postgres in container `NAME` `` polls `pg_isready -h 127.0.0.1` inside the container once a second, over TCP, because an image that initialises on a temporary server would otherwise be called ready early. A container that does not exist, or has exited, fails at once with its own log, not after the limit.
- ``wait up to Ns for postgres in pod `NAME` `` polls `pg_isready -h 127.0.0.1` through `kubectl exec` the same way. It is not spelled ``pod `NAME` ready``, because pod Ready comes before postgres is up. Both pod forms fail at once, with the pod's `describe` and log tail, if the pod is missing, has Failed or Succeeded, its container has terminated, or it is in CrashLoopBackOff. A pod still pulling its image is polled to the limit. The namespace is the reader's current context's.
- ``wait up to Ns for pod `NAME` ready`` waits for the Kubernetes Ready condition, for a pod that runs no postgres (the guide's `test-pod` runs `sleep infinity`, and a bot reaches `kubectl exec` seconds after `kubectl run`). For such a pod Ready means running, which is what a reader waits for. It never `exec`s into the pod. A plain `run command: kubectl wait ...` was rejected because the page does not give it, so the lint would call it `command not on page`.

The pod forms share one loop in `lib/wait.mjs`.

**The lint checks a `wait` for its name, and nothing else.** It runs nothing the reader runs, so it is not a "command not on page", like `answer`. The name must be a whole word on the reader's path, so a guide that renames the container makes the wait stale and the lint says so. A pod name may end in an ordinal: the lint strips a trailing `-N` and checks that what is left is a whole word on the reader's path, because the page names the StatefulSet and never the pod. A name with no ordinal must itself be on the path. Both pod forms are checked with this rule. Ceiling: the ordinal is not checked against `replicas`, so `timescaledb-7` passes the lint and fails at the probe.

## Asserting and ending a session

**A bare plan asserts on a command's output with ``expect output contains `text` ``.** It checks the transcript of the `run command:` above it, once that command has exited. It is a plain case-sensitive substring, never a regex. `expect rows:` was not extended to this case: it goes through the SSM tunnel with the box's generated password, the guide's is the literal `password`, and asserting through a different route than the reader's would check the database and not what the page says the reader sees. The lint ties the text to the page two ways: it must be in a non-shell fence on the reader's path (`asserts text the page never shows`), and it must not be text the plan types for that command (`asserts text the plan itself types`; a terminal echoes what is typed). Known ceilings: a `sql` fence holds typed input as well as sample output, so "non-shell fence" approximates "sample output"; the driver keeps only the last 80 lines or 6000 characters of a transcript; and a substring is satisfied by a longer string that contains it (`timescaledb` by the `timescaledb_toolkit` row), so a plan asserts on a line only the right row has.

**A psql session the guide never ends is ended with ``answer `postgres=#` with `<Ctrl-D>` ``.** A guide may never tell the reader to leave psql, and a `\q` answer is `command not on page`. Without an end the session sits at its prompt until the driver's idle timeout fails the step. `<Ctrl-D>` is a key reply like `<Enter>`: declared in the plan, typed by the driver without a trailing Enter, and exempt from the lint because it is not a command a reader types. A harness that closed the session silently was rejected, because the asymmetry between a bot and a reader is declared in the plan (ADR 0007), and a `\q` exemption was rejected because it loosens the lint for a command no reader types.

**Known ceiling: a pod that crashes after the last documented step is invisible to a plan run.** Where the page promises nothing to assert, there is nothing to tie an `expect output` to. A generic "no pod in Error" check was rejected: it would fail guides that legitimately show transient states, and it would assert what the page never promises.

## What the lint reads

**A command in a fence that is not tagged as shell is the docs' to fix, and the tool reports it.** ADR 0010 reads only `bash`, `sh` and `shell` fences, so a command in a fence with no tag, or one tagged `yaml`, is one the lint cannot see. The fix belongs in the docs: tag the fence `bash`. The tool does two things, neither of which relaxes the exact-equality contract. A plan that runs a command the page gives only in such a fence gets its own finding, `command in an untagged fence`, instead of the misleading "command not on page", and `test-page` refuses it as it does any drift. And such a fence on the reader's path that looks like a command and that the plan neither runs nor `skip`s is listed as an advisory by `lint-plan` and as a warning by `test-page`, so the lint cannot pass over it in silence. "Looks like a command" is a heuristic with a known ceiling: the first word is one the page's own shell fences start a command with, or one of a short list (`sudo`, `docker`, `kubectl`, `psql`, …), so a fence of sample output is not listed. A `skip` of such a command is not stale; it is how a plan says it knows.

**A plan keeps a manifest's indentation.** A `run command:` body keeps its lines' relative indentation (only the common leading indent is stripped), and the lint compares heredoc bodies the same way, because in a YAML manifest the indentation is the meaning.

**A page's heredoc terminator that is not at column 0 is a guide finding, `heredoc never ends as shown`.** The column is counted after the fence is dedented by its own opening indent. `<<-` with leading tabs is exempt. Without the finding a plan goes green over a guide whose pasted fence never ends. Ceiling: the lint reads the MDX source, and what the rendered site shows is not checked.

## Considered and rejected

- *Treating every untagged fence as shell.* One line, but a fence of sample output with no tag would then be a command the plan must run.
- *Reading untagged fences when their first word is a known command, as a rule instead of a warning.* It adds a list to maintain and makes the contract depend on it. The same list is used here only to decide what to warn about.
- *A free-text `tab:` with the page's labels.* Flexible, but a typo only fails at lint time and the plan drifts from the page's spelling. The fixed table matches how `os:` works.
- *Inferring the path from the plan's commands.* ADR 0004: explicit, never inferred.
- *Preinstalling Docker and `psql` on every bare box.* It would hide a distro guide that forgets the client.
- *Prerequisites as plan steps.* Their commands are not on the page, so the lint's "command not on page" fails them.
- *Pinning prerequisite versions.* Reproducible, but the pins go stale unnoticed, and a guide failing because Docker changed is something a reader would hit too. Versions are recorded in the report, and pinned only if runs turn flaky.
- *A baked AMI with the prerequisites.* Fast, but it is account-admin work, and a baked box drifts toward the preinstalled target ADR 0007 exists to avoid.
- *A pure delay (`wait 15s`) or a retry-on-failure.* A delay is a guess against an image pull of unknown size, and a retry hides real failures.
- *A managed cluster for Kubernetes.* See "Prerequisites".

## Consequences

- `lib/fidelity.mjs` takes the reader's path from the plan's `path:` or `os:`, not from a hard-coded pair of labels.
- A run's result rows carry a `path` component (`scripts/test-page.mjs`), the report prints it (`lib/report.mjs`), and `CONTEXT.md` defines "bare target", "run unit" and "prerequisite" to match.
- The plans go on the real install page. A dev fixture per path (`docker-dev.mdx`, `kubernetes-dev.mdx` under `dev-fixtures/`) carries the guide's flow with its deviations labelled, so the harness is covered where a real page cannot be green yet.
- `scripts/check-needs.mjs`, `scripts/check-needs-kubernetes.mjs`, `scripts/check-wait.mjs`, `scripts/check-wait-pod.mjs`, `scripts/check-expect-output.mjs`, `scripts/check-manifest-lint.mjs`, `scripts/check-guide-lint.mjs` (the `path:` line and untagged fences) and `scripts/check-pty-driver.mjs` (the `<Ctrl-D>` reply and the idle timeout) cover these rules without AWS.

Related: ADR 0004 (explicit, never inferred), ADR 0005 (ad hoc per block), ADR 0006 (headers declare how a plan runs), ADR 0007 (verbatim), ADR 0008 (`os:`), ADR 0010 (the reader's path).
