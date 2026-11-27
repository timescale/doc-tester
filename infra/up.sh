#!/bin/bash
# Provisions the self-hosted TimescaleDB EC2 target. One known-safe command instead of raw
# `terraform apply` — an agent (or you) runs this, not Terraform directly.
# Ignores the EC2 slot lease (docs/adr/0009): another run may be using the box. Check
# `node scripts/slot.mjs status` first; `node scripts/slot.mjs down` is the safe way to tear down by hand.
set -euo pipefail
cd "$(dirname "$0")"

# shellcheck disable=SC1091
source ./env.sh # .env, then the AWS identity rule (EDU-1069)

./init.sh
if [ -n "${DOCTEST_TF_AUTO_APPROVE:-}" ]; then
  terraform apply -auto-approve
else
  terraform apply
fi
