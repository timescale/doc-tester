// The standing test services, and the project they live in, read from the environment.
//
// These were two hardcoded copies of the same object literal — lib/walk.mjs and lib/fork.mjs — plus
// the ids written into comments and CLAUDE.md. The standing services have been recreated twice, and
// each time that meant a code change in several places, with a stale id left behind somewhere. A
// stale id does not fail cleanly: the run points at a service nobody looked at.
//
// So: nothing in git names a service. A missing value throws on import rather than defaulting to an
// id that used to be right, because a wrong-but-plausible default is the failure this replaces.
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ENV_FILE = join(dirname(fileURLToPath(import.meta.url)), "..", ".env");
if (existsSync(ENV_FILE)) process.loadEnvFile(ENV_FILE);

function required(name) {
  const v = (process.env[name] || "").trim();
  if (!v) throw new Error(`${name} is not set — put the standing test project and services in .env (see .env.example).`);
  return v;
}

export const PROJECT_ID = required("DOCTEST_PROJECT_ID");
export const STANDING_SERVICE_IDS = { aws: required("DOCTEST_SERVICE_AWS"), azure: required("DOCTEST_SERVICE_AZURE") };
// The S3 bucket that holds the Terraform state and the EC2 slot lease. Its name contains the AWS
// account number, so it is read from the environment like the ids above and never written in git.
export const TFSTATE_BUCKET = required("DOCTEST_TFSTATE_BUCKET");
