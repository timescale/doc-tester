#!/bin/bash
# Tears down the self-hosted TimescaleDB EC2 target. One known-safe command instead of raw
# `terraform destroy`.
# Ignores the EC2 slot lease (docs/adr/0009): another run may be using the box. Check
# `node scripts/slot.mjs status` first; `node scripts/slot.mjs down` is the safe way to tear down by hand.
set -euo pipefail
cd "$(dirname "$0")"

ENV_FILE="../.env"
if [ -f "$ENV_FILE" ]; then
  set -a
  # shellcheck disable=SC1090
  source "$ENV_FILE"
  set +a
fi

export AWS_PROFILE="${DOCTEST_AWS_PROFILE:-docs-tester}"

if [ -n "${DOCTEST_TF_AUTO_APPROVE:-}" ]; then
  terraform destroy -auto-approve
else
  terraform destroy
fi
