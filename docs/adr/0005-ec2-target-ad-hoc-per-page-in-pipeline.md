# EC2 self-hosted target is ad hoc per page in the pipeline, not standing

Tiger Cloud's standing services (`aws`/`azure`) let ordinary steps run directly, and only destructive plans pay the cost of a fork. A standing self-hosted EC2 box would need the same protection from destructive steps — but EC2 has no cheap native "fork" the way Tiger Cloud does, and self-hosted docs pages are disproportionately the stateful/destructive kind (backup/restore, upgrades, migration, replication) — exactly what this substrate exists to test.

We provision the EC2 target ad hoc per page during a pipeline run, mirroring `infra/`'s own up/tunnel/destroy lifecycle. This also matches Tiger Cloud's own existing granularity: `test-batch.mjs` already forks fresh per page with no shared fork state across a batch (confirmed in code, not assumed), so this isn't a new sharing model — it's the same one, applied to the new substrate.

Runs share one slot and take turns on it: ADR 0009.

This sidesteps the "protect the standing box from destructive steps" problem entirely by never having a standing box. The cost is cloud-init boot time (roughly 2-3 minutes) paid on every self-hosted page in a run. That's accepted for now, not solved: another internal project hit the identical cold-boot problem for its CI runners and fixed it by baking a Packer AMI instead of installing at boot (about 4 minutes down to under 2). The same move is the documented escape hatch here if iteration speed becomes a real blocker — not before.
