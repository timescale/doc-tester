// Files a page tells the reader to download, fetched for the run and deleted after it.
//
// Several pages hand the reader a dataset and then use it: tiger-cloud-essentials unzips
// crypto_sample.zip and both of its documented ingest routes read the CSVs out of it — `\COPY` from
// psql, and a drag-and-drop upload in the Console. Neither can be tested without those files
// actually being on disk, because `\COPY` is a CLIENT-side command and a file input needs a real
// path. That is why a plan's Setup section exists, and until now nothing executed it.
//
// Everything lands in one throwaway directory per run and is removed in a finally, including on
// failure. Whoever runs the tool to test a page should have nothing left on their machine
// afterwards — these are somebody else's sample datasets, not something to accumulate silently in
// a home directory.

import { mkdtempSync, rmSync, existsSync, readdirSync, statSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, basename, extname } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileP = promisify(execFile);

// Only http(s), and only a URL the plan itself names — a plan lives in our own repo, so this is not
// arbitrary input, but there is no reason to widen it either.
const ALLOWED = /^https:\/\/[\w.-]+\/[\w./-]*$/;

// A download is bounded: it gives up after TIMEOUT_MS (headers and body together), stops reading past
// the size cap (DOCTEST_FIXTURE_MAX_MB, default 200), and follows at most MAX_REDIRECTS redirects, each
// of which must be https. `fetch` would follow a redirect to plain http, or forever, on its own.
const TIMEOUT_MS = 120_000;
const MAX_REDIRECTS = 5;
const maxBytes = () => (Number(process.env.DOCTEST_FIXTURE_MAX_MB) || 200) * 1024 * 1024;

// A redirect target may carry a query (a signed CDN URL), so it is held to less than the URL a plan
// names: https, no embedded credentials. The unzip step that follows is NOT bounded here (a zip that
// expands far past its size is not caught).
export async function fetchBounded(url, { fetchImpl = fetch, maxBytes: cap = maxBytes(), timeoutMs = TIMEOUT_MS } = {}) {
  const signal = AbortSignal.timeout(timeoutMs);
  let current = url;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const res = await fetchImpl(current, { redirect: "manual", signal });
    const to = res.status >= 300 && res.status < 400 && res.headers.get("location");
    if (to) {
      await res.body?.cancel();
      const next = new URL(to, current);
      if (next.protocol !== "https:" || next.username || next.password) {
        throw new Error(`refused a redirect to ${next.protocol}//${next.host}${next.pathname} — only https redirects are followed`);
      }
      current = next.href;
      continue;
    }
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const declared = Number(res.headers.get("content-length"));
    if (declared > cap) throw new Error(`${declared} bytes is over the ${Math.round(cap)}-byte limit (DOCTEST_FIXTURE_MAX_MB)`);
    const chunks = [];
    let total = 0;
    for await (const chunk of res.body) {
      total += chunk.length;
      if (total > cap) throw new Error(`more than the ${Math.round(cap)}-byte limit (DOCTEST_FIXTURE_MAX_MB)`);
      chunks.push(chunk);
    }
    return Buffer.concat(chunks);
  }
  throw new Error(`more than ${MAX_REDIRECTS} redirects`);
}

/**
 * Fetch each URL into a fresh temporary directory, unzipping archives.
 * Returns { dir, files, errors } — dir is null when there was nothing to fetch.
 */
export async function prepareFixtures(urls) {
  if (!urls || !urls.length) return { dir: null, files: [], errors: [] };
  const dir = mkdtempSync(join(tmpdir(), "doctest-fixtures-"));
  const errors = [];

  for (const url of urls) {
    if (!ALLOWED.test(url)) {
      errors.push(`refusing to fetch ${url} — only plain https URLs are allowed`);
      continue;
    }
    const name = basename(new URL(url).pathname) || "download";
    const target = join(dir, name);
    try {
      await writeFile(target, await fetchBounded(url));
      if (extname(name).toLowerCase() === ".zip") {
        // -j junks stored paths, so a crafted archive cannot write outside the directory, and -o
        // overwrites rather than prompting (a prompt would hang an unattended run).
        await execFileP("unzip", ["-o", "-j", target, "-d", dir], { timeout: 120_000 });
        rmSync(target, { force: true });
      }
    } catch (e) {
      errors.push(`${url} — ${(e.message || "").split("\n")[0]}`);
    }
  }

  const files = existsSync(dir) ? readdirSync(dir).filter((f) => statSync(join(dir, f)).isFile()) : [];
  return { dir, files, errors };
}

/** Remove the directory and everything in it. Safe to call with null, and never throws. */
export function cleanupFixtures(dir) {
  if (!dir) return true;
  try {
    rmSync(dir, { recursive: true, force: true });
    return !existsSync(dir);
  } catch {
    return false;
  }
}