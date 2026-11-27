#!/bin/bash
# Opens an SSM Session Manager port-forward to the EC2 target's Postgres port. There is no public
# inbound port to connect to instead (see docs/adr/0002) — this is the only way in. Leave this
# running in its own terminal; scripts/ec2-smoke-test.mjs connects through it.
set -euo pipefail
cd "$(dirname "$0")"

# shellcheck disable=SC1091
source ./env.sh # .env, then the AWS identity rule (EDU-1069)
LOCAL_PORT="${DOCTEST_EC2_LOCAL_PORT:-55432}"

INSTANCE_ID=$(terraform output -raw instance_id)

echo "Forwarding localhost:$LOCAL_PORT -> $INSTANCE_ID:5432 via SSM. Ctrl-C to close."
aws ssm start-session \
  --target "$INSTANCE_ID" \
  --document-name AWS-StartPortForwardingSession \
  --parameters "{\"portNumber\":[\"5432\"],\"localPortNumber\":[\"$LOCAL_PORT\"]}"
