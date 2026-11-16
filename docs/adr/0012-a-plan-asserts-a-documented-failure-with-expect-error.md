---
status: accepted
---

# A plan asserts a documented failure with `expect error`

Pages state failure modes in prose: "you get an error if you turn the table into a hypertable partitioned by `time` and `user_id`" (hypertables-and-unique-indexes), "a unique constraint must include the time column" (your-first-hypertable). Until now a plan could not carry them. `run SQL:` passes only when a statement succeeds, so every documented failure was a blank in the claims table, and nothing noticed when the product started accepting what the page said it rejects.

**The verb.** `expect error: <statement>` passes when the statement fails and fails when it succeeds. `expect error containing \`text\`: <statement>` also fails when the error message does not contain the text, compared case-insensitively, so a plan can pin the reason and not just the fact. The statement is written like `run SQL:`, on the step line or indented under a trailing colon, wrapped in backticks.

**Compiled, not a new path.** Like `expect rows:`, the verb compiles to a `DO` block that raises, marked as an assertion, so both walkers, the dry run (`plan-sql.mjs`) and the assertion count need nothing new. Inside the block the statement runs through `EXECUTE` in a sub-block; an error there is caught and recorded, then the block raises if no error came, or if the message lacks the pinned text. `EXECUTE` rather than the statement inline, because a bare `SELECT` inside PL/pgSQL is itself an error ("query has no destination for result data"), which would make a succeeding `SELECT` look like the failure the plan expected.

**The lint grades the statement.** The statement under test is the plan's copy of something the page gives, so it is graded for drift like `run SQL:`, and it counts as run for the "statements not run" check. Every other assertion stays exempt, as before.

**Limits.** The `DO`-block limit of `expect rows:` applies: a statement that cannot run inside a function (`CREATE DATABASE`, `VACUUM`, `CREATE INDEX CONCURRENTLY`, transaction control) cannot be asserted this way. A failure that is not a SQL error, for example a command's exit code, is a shell `test` on the box, as before.

Related: ADR 0006 (headers declare how a plan runs), the `expect rows:` design in `lib/plan.mjs`.
