// Console session handling for Playwright: a cheap pre-flight check on the stored
// session, the headless email+password login itself, and the live probe that decides
// whether a re-login is actually needed.
//
// The Console's server silently reissues the access-token cookie when any /api/*
// request arrives with a valid refresh-token, so Playwright-level requests stay
// authenticated even after the access-token JWT has expired.
//
// That is why the stored state alone can NEVER tell us whether we're logged in: a
// refresh-token cookie sitting in state.json may already have been invalidated
// server-side (it lapses after enough idle days), and nothing local reflects that.
// Trusting its mere presence is what made a stale session look healthy and then fail
// as a wall of click timeouts, with every screenshot quietly showing the login page.
// So ensureFreshSession() only catches the unambiguous cases, and the authority on
// "are we in?" is landsOnLogin() against the live Console, with loginAndSaveState()
// as the automatic repair.

import { chromium } from "playwright";
import { existsSync, readFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const ENV = join(ROOT, ".env");

function isExpiredJwt(jwt) {
  try {
    const payload = JSON.parse(Buffer.from(jwt.split(".")[1], "base64url").toString());
    // treat as expired if less than 60 seconds remain
    return payload.exp * 1000 < Date.now() + 60_000;
  } catch {
    return true;
  }
}

// Fast local pre-flight. Returns true when the stored session is worth trying at all.
// A false here is definitive (nothing usable on disk); a true is only optimistic, and
// gets confirmed or overturned by landsOnLogin().
// The saved state holds cookies for every host the browser visited; the session cookies are the ones
// set on `.tigerdata.com` or `console.cloud.tigerdata.com`. A suffix test, not a substring one
// (CodeQL js/incomplete-url-substring-sanitization).
function isTigerDataDomain(domain) {
  return domain === "tigerdata.com" || Boolean(domain?.endsWith(".tigerdata.com"));
}

export function ensureFreshSession(stateFile) {
  if (!existsSync(stateFile)) return false;

  const state = JSON.parse(readFileSync(stateFile, "utf8"));
  const refreshCookie = state.cookies?.find(
    (c) => c.name === "refresh-token" && isTigerDataDomain(c.domain)
  );
  const accessCookie = state.cookies?.find(
    (c) => c.name === "access-token" && isTigerDataDomain(c.domain)
  );

  // A refresh-token whose OWN expiry has passed is dead beyond doubt, and that is knowable here
  // without a browser. Saying "worth trying" anyway costs a context, a navigation and up to two
  // 45s probes before createSession gives up and logs in regardless. Server-side invalidation of a
  // still-unexpired cookie remains undetectable locally — that is landsOnLogin()'s job, not this
  // function's. Playwright writes -1 for a session cookie, which says nothing about validity.
  const expired = (c) => c?.expires > 0 && c.expires * 1000 < Date.now() + 60_000;
  if (refreshCookie?.value) return !expired(refreshCookie);
  return !!(accessCookie && !isExpiredJwt(accessCookie.value));
}

// Did this navigation land us on the login screen? The Console bounces any
// unauthenticated request to /login, so the post-navigation URL is the signal.
export function landsOnLogin(page) {
  return /\/login|\/signin/.test(page.url());
}

export function consoleCredentials() {
  if (existsSync(ENV)) process.loadEnvFile(ENV);
  const email = process.env.CONSOLE_EMAIL;
  const password = process.env.CONSOLE_PASSWORD;
  if (!email || !password) {
    throw new Error(
      "CONSOLE_EMAIL and CONSOLE_PASSWORD must be set in .env or environment to log in."
    );
  }
  return { email, password };
}

// Log into the Console headlessly with email + password and save the session to
// stateFile. Used both by `npm run login` and automatically by createSession() when
// the live probe finds the stored session dead.
/**
 * Sign in on THIS page, so a run bounced to /login halfway through recovers in place rather than only
 * at session creation. A long run outlives the Console session, and an expiry mid-walk otherwise
 * reports every remaining step as a missing control when the page was simply /login.
 *
 * One copy of the form flow, because two would drift the moment the Console renames a field.
 */
export async function signIn(page) {
  const { email, password } = consoleCredentials();
  await page.goto("https://console.cloud.tigerdata.com/login", { waitUntil: "load", timeout: 60000 });
  await page.waitForTimeout(2000); // let the React app render the form

  // Dismiss cookie banner if present — it can intercept clicks otherwise.
  await page
    .getByRole("button", { name: /close this dialog|accept|got it/i })
    .first()
    .click({ timeout: 3000 })
    .catch(() => {});

  await page.locator('[name="email"]').fill(email);
  await page.locator('[name="password"]').fill(password);
  await page.getByRole("button", { name: "Log in", exact: true }).click();

  await page.waitForURL(/\/projects\//, { timeout: 30000 });
  await page.waitForLoadState("networkidle", { timeout: 20000 }).catch(() => {});
  return email;
}

export async function loginAndSaveState(stateFile) {
  const { email, password } = consoleCredentials();
  mkdirSync(dirname(stateFile), { recursive: true });

  const browser = await chromium.launch({ headless: process.env.DOCTEST_HEADED !== "1" });
  try {
    const context = await browser.newContext({ viewport: { width: 1280, height: 860 } });
    const page = await context.newPage();

    await signIn(page);
    await context.storageState({ path: stateFile });
    return email;
  } finally {
    await browser.close();
  }
}