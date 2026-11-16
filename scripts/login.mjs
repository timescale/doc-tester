// Log into the Tiger Cloud Console headlessly using email + password.
//
// Requires CONSOLE_EMAIL and CONSOLE_PASSWORD in .env (or environment).
// Runs without a visible browser window — suitable for CI.
//
// Running this by hand is now optional: test-page.mjs probes the live Console on every run and
// re-logs in by itself when the saved session is dead (see lib/auth.mjs). Use this to seed or
// refresh .auth/state.json deliberately, or to check the credentials work at all.
//
// Note: this only works for accounts that sign in with a password. If the account has SSO
// enabled, the Console won't accept email+password and the login fails.

import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { loginAndSaveState, consoleCredentials } from "../lib/auth.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const STATE = join(ROOT, ".auth", "state.json");

try {
  const { email } = consoleCredentials();
  console.log(`Logging in as ${email} (headless)...`);
  await loginAndSaveState(STATE);
  console.log("Logged in. Session saved to .auth/state.json");
} catch (e) {
  console.error(e.message);
  process.exit(1);
}