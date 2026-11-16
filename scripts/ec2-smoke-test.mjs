#!/usr/bin/env node
// Smoke-test the self-hosted TimescaleDB EC2 target: fetch its Terraform-generated password from
// SSM Parameter Store, connect through the SSM tunnel (infra/tunnel.sh must already be running in
// another terminal), and confirm TimescaleDB is actually installed by creating a real hypertable
// in a transaction that ROLLS BACK. Nothing sticks.
//
//   node scripts/ec2-smoke-test.mjs
//
// This proves infra + IAM + SSM + the TimescaleDB install work together end to end. It does not
// wire the target into scripts/test-page.mjs or lib/walk.mjs — see docs/adr/ and issue #52.
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { execFileSync } from "node:child_process";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const ENV_FILE = join(ROOT, ".env");
if (existsSync(ENV_FILE)) process.loadEnvFile(ENV_FILE);

const PROFILE = process.env.DOCTEST_AWS_PROFILE || "docs-tester";
const PORT = process.env.DOCTEST_EC2_LOCAL_PORT || "55432";

console.error(`Fetching the generated password from SSM Parameter Store (profile ${PROFILE})…`);
const password = execFileSync(
  "aws",
  [
    "ssm",
    "get-parameter",
    "--name",
    "/doc-testing-tool/ec2/db-password",
    "--with-decryption",
    "--profile",
    PROFILE,
    "--query",
    "Parameter.Value",
    "--output",
    "text",
  ],
  { encoding: "utf8" },
).trim();

const sql = `\\set ON_ERROR_STOP 1
BEGIN;
\\echo -- enabling the timescaledb extension (the install guide only installs the package, same as any real doc procedure would need to)
CREATE EXTENSION IF NOT EXISTS timescaledb;
\\echo -- confirming the timescaledb extension is installed
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'timescaledb') THEN
    RAISE EXCEPTION 'timescaledb extension is not installed';
  END IF;
END $$;
\\echo -- creating a throwaway hypertable
CREATE TABLE smoke_test (t timestamptz NOT NULL, v double precision);
SELECT create_hypertable('smoke_test', 't');
INSERT INTO smoke_test VALUES (now(), 1.0);
SELECT count(*) FROM smoke_test;
ROLLBACK;
`;

console.error(`Connecting to localhost:${PORT} as postgres (infra/tunnel.sh must be running)…`);
try {
  const output = execFileSync(
    "psql",
    ["-h", "localhost", "-p", PORT, "-U", "postgres", "-d", "postgres", "-v", "ON_ERROR_STOP=1", "-f", "-"],
    { encoding: "utf8", input: sql, env: { ...process.env, PGPASSWORD: password } },
  );
  console.log(output);
  console.log("PASS: TimescaleDB is installed and a hypertable was created successfully.");
} catch (err) {
  console.error("FAIL:", err.stdout || err.message);
  process.exit(1);
}
