#!/bin/bash
# Initializes Terraform's working directory against the state bucket. This is the one place that
# knows how: up.sh, down.sh and the tool's pre-flight (lib/ec2.mjs) all call it, so a fresh clone
# needs no manual step before its first run. Safe to run any number of times.
set -euo pipefail
cd "$(dirname "$0")"

# shellcheck disable=SC1091
source ./env.sh # .env, then the AWS identity rule (EDU-1069)

# One-off rollover: Terraform refuses to init when the backend block differs from the one cached in
# .terraform/, and the block lost its profile line (EDU-1069), so a clone that had run before stops
# here with "Backend configuration changed". Only then is -reconfigure passed: bucket and key are the
# same, so nothing is migrated. Left on permanently it would also wave through a changed bucket, which
# is the one wrong state location init exists to catch.
RECONFIGURE=""
if grep -Eq '"profile": *"' .terraform/terraform.tfstate 2>/dev/null; then RECONFIGURE="-reconfigure"; fi # a named profile; the cache lists every key, null included
terraform init -input=false $RECONFIGURE -backend-config="bucket=${DOCTEST_TFSTATE_BUCKET:?set DOCTEST_TFSTATE_BUCKET in .env (see .env.example)}"
