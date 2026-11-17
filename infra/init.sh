#!/bin/bash
# Initializes Terraform's working directory against the state bucket. This is the one place that
# knows how: up.sh, down.sh and the tool's pre-flight (lib/ec2.mjs) all call it, so a fresh clone
# needs no manual step before its first run. Safe to run any number of times.
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

terraform init -input=false -backend-config="bucket=${DOCTEST_TFSTATE_BUCKET:?set DOCTEST_TFSTATE_BUCKET in .env (see .env.example)}"
