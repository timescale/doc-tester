// The standing test services, the project they live in, and the Terraform state bucket, read from
// the environment by the code path that needs them.
//
// These were two hardcoded copies of the same object literal — lib/walk.mjs and lib/fork.mjs — plus
// the ids written into comments and CLAUDE.md. The standing services have been recreated twice, and
// each time that meant a code change in several places, with a stale id left behind somewhere. A
// stale id does not fail cleanly: the run points at a service nobody looked at.
//
// So: nothing in git names a service, and a missing value throws rather than defaulting to an id
// that used to be right. It throws when the value is NEEDED, not on import: a Tiger Cloud run needs
// the project and the standing services, a self-hosted run needs the state bucket, and the offline
// checks, lint-plan and plan-sql need none of them (EDU-1070). Until the entry point asks, the
// exports below are null; they are live bindings, so every importer sees the values once loaded.
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ENV_FILE = join(dirname(fileURLToPath(import.meta.url)), "..", ".env");
if (existsSync(ENV_FILE)) process.loadEnvFile(ENV_FILE); // a variable already in the environment wins over the file

const read = (name) => (process.env[name] || "").trim();
function requireAll(names, forWhat) {
  const missing = names.filter((n) => !read(n));
  if (missing.length) throw new Error(`${missing.join(", ")} ${missing.length > 1 ? "are" : "is"} not set — ${forWhat} (see .env.example).`);
}

export let PROJECT_ID = null;
export let STANDING_SERVICE_IDS = { aws: null, azure: null };
export let TFSTATE_BUCKET = null;

// A run that drives Tiger Cloud: the Console walk, a fork, the project lock.
export function requireCloud() {
  requireAll(["DOCTEST_PROJECT_ID", "DOCTEST_SERVICE_AWS", "DOCTEST_SERVICE_AZURE"], "a Tiger Cloud run needs the standing test project and services in .env");
  PROJECT_ID = read("DOCTEST_PROJECT_ID");
  STANDING_SERVICE_IDS = { aws: read("DOCTEST_SERVICE_AWS"), azure: read("DOCTEST_SERVICE_AZURE") };
  return { projectId: PROJECT_ID, standing: STANDING_SERVICE_IDS };
}

// A run that provisions the EC2 target: the slot lease and the Terraform state live in this bucket.
// Its name contains the AWS account number, so it is read from the environment and never written in git.
export function requireAws() {
  requireAll(["DOCTEST_TFSTATE_BUCKET"], "a self-hosted run needs the Terraform state bucket in .env");
  TFSTATE_BUCKET = read("DOCTEST_TFSTATE_BUCKET");
  return { tfstateBucket: TFSTATE_BUCKET };
}
