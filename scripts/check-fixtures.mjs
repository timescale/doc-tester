#!/usr/bin/env node
// Checks the download step (lib/fixtures.mjs, issue #33 / the security audit of 2026-10-22): a plan's
// `download <url>` is fetched with a timeout, a size cap and a redirect rule, so a slow, huge or
// redirecting server cannot hang a run, fill a disk, or walk the fetch off https. No network: `fetch`
// is a stub that returns the responses each case needs.
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fetchBounded, prepareFixtures, cleanupFixtures } from "../lib/fixtures.mjs";

let failed = 0;
// A check that has not finished in 8s has failed: without a deadline, a guard that stops working shows
// up as a hung run instead of a red line.
const check = async (name, fn) => {
  const deadline = new Promise((_, rej) => setTimeout(() => rej(new Error("did not finish within 8s")), 8000).unref());
  try { await Promise.race([fn(), deadline]); console.log(`  ok   ${name}`); } catch (e) { failed++; console.log(`  FAIL ${name}\n       ${String(e.message).split("\n").join("\n       ")}`); }
};

const body = (...chunks) => new ReadableStream({ start(c) { for (const k of chunks) c.enqueue(Buffer.from(k)); c.close(); } });
const ok = (text, headers = {}) => new Response(body(text), { status: 200, headers });
const redirect = (to, status = 302) => new Response(null, { status, headers: { location: to } });
// a fetch that answers from a script of responses, in order, and records what it was asked
const script = (...responses) => {
  const calls = [];
  const impl = async (url, opts) => { calls.push({ url, opts }); const r = responses.shift(); if (!r) throw new Error(`unexpected fetch of ${url}`); return typeof r === "function" ? r() : r; };
  return { impl, calls };
};
const U = "https://example.com/data.csv";

console.log("fetchBounded: the happy path and redirects");
await check("a plain 200 returns the bytes, and asks for redirects to be handled here, not by fetch", async () => {
  const s = script(ok("a,b\n1,2\n"));
  assert.equal((await fetchBounded(U, { fetchImpl: s.impl })).toString(), "a,b\n1,2\n");
  assert.equal(s.calls[0].opts.redirect, "manual");
});
await check("an https redirect is followed, query string and relative Location included, and the final body returned", async () => {
  const s = script(redirect("/moved/data.csv?sig=abc"), redirect("https://cdn.example.net/x.csv?sig=1"), ok("done"));
  assert.equal((await fetchBounded(U, { fetchImpl: s.impl })).toString(), "done");
  assert.deepEqual(s.calls.map((c) => c.url), [U, "https://example.com/moved/data.csv?sig=abc", "https://cdn.example.net/x.csv?sig=1"]);
});
await check("a redirect to plain http is refused, and that URL is never requested", async () => {
  const s = script(redirect("http://example.com/data.csv"), ok("never"));
  await assert.rejects(fetchBounded(U, { fetchImpl: s.impl }), /only https/);
  assert.equal(s.calls.length, 1);
});
await check("a redirect to another scheme is refused too (the control for the one above is the https case)", async () => {
  await assert.rejects(fetchBounded(U, { fetchImpl: script(redirect("file:///etc/passwd")).impl }), /only https/);
});
await check("a redirect that names a user and password is refused", async () => {
  await assert.rejects(fetchBounded(U, { fetchImpl: script(redirect("https://u:p@example.com/x")).impl }), /only https/);
});
await check("a redirect loop stops after five hops", async () => {
  const s = script(...Array.from({ length: 8 }, () => redirect(U)));
  await assert.rejects(fetchBounded(U, { fetchImpl: s.impl }), /redirects/);
  assert.equal(s.calls.length, 6); // the request, then five hops
});
await check("exactly five redirects is allowed (the boundary)", async () => {
  const s = script(...Array.from({ length: 5 }, () => redirect(U)), ok("end"));
  assert.equal((await fetchBounded(U, { fetchImpl: s.impl })).toString(), "end");
});
await check("a non-2xx answer is an error naming the status", async () => {
  await assert.rejects(fetchBounded(U, { fetchImpl: script(new Response("nope", { status: 404 })).impl }), /HTTP 404/);
});

console.log("fetchBounded: size and time");
// AbortSignal.timeout's timer does not keep the process alive (a real open socket does), so the stubs
// below that wait on it need something that does.
const keepAlive = setInterval(() => {}, 1000);
await check("a declared length over the cap is refused without reading the body", async () => {
  const unread = new Response(new ReadableStream({ pull() { throw new Error("the body was read"); } }), { status: 200, headers: { "content-length": "1000" } });
  await assert.rejects(fetchBounded(U, { fetchImpl: script(unread).impl, maxBytes: 999 }), /limit/);
});
await check("a body over the cap with no declared length is cut off while it streams", async () => {
  let pulled = 0;
  // "endless" up to 30 chunks, so a missing cap shows as a returned body and not as a crash
  const endless = new ReadableStream({ pull(c) { if (++pulled > 30) c.close(); else c.enqueue(Buffer.alloc(100)); } });
  await assert.rejects(fetchBounded(U, { fetchImpl: script(new Response(endless, { status: 200 })).impl, maxBytes: 250 }), /limit/);
  assert.ok(pulled < 10, `read ${pulled} chunks of an endless body`);
});
await check("a body exactly at the cap is accepted (the control for the two above)", async () => {
  const r = await fetchBounded(U, { fetchImpl: script(ok("x".repeat(100), { "content-length": "100" })).impl, maxBytes: 100 });
  assert.equal(r.length, 100);
});
await check("a server that never answers is abandoned at the timeout", async () => {
  const hang = (_url, { signal }) => new Promise((_, rej) => signal.addEventListener("abort", () => rej(signal.reason)));
  const t0 = Date.now();
  await assert.rejects(fetchBounded(U, { fetchImpl: hang, timeoutMs: 60 }), /timed? ?out|abort/i);
  assert.ok(Date.now() - t0 < 2000);
});
await check("one that answers and then stalls mid-body is abandoned too", async () => {
  const stall = (_url, { signal }) => {
    const s = new ReadableStream({ start(c) { c.enqueue(Buffer.from("partial")); signal.addEventListener("abort", () => c.error(signal.reason)); } });
    return Promise.resolve(new Response(s, { status: 200 }));
  };
  await assert.rejects(fetchBounded(U, { fetchImpl: stall, timeoutMs: 60 }), /timed? ?out|abort/i);
});

clearInterval(keepAlive);

console.log("prepareFixtures: the same rules through the real entry point");
const realFetch = globalThis.fetch;
try {
  await check("a plan's download lands in the throwaway directory, and cleanup removes it", async () => {
    globalThis.fetch = script(ok("id\n1\n")).impl;
    const r = await prepareFixtures(["https://example.com/sample.csv"]);
    try {
      assert.deepEqual(r.errors, []);
      assert.deepEqual(r.files, ["sample.csv"]);
      assert.equal(readFileSync(join(r.dir, "sample.csv"), "utf8"), "id\n1\n");
    } finally { assert.equal(cleanupFixtures(r.dir), true); }
    assert.equal(existsSync(r.dir), false);
  });
  await check("a plain-http URL in the plan is refused before any request", async () => {
    const s = script(ok("never"));
    globalThis.fetch = s.impl;
    const r = await prepareFixtures(["http://example.com/sample.csv"]);
    cleanupFixtures(r.dir);
    assert.match(r.errors[0], /only plain https URLs/);
    assert.equal(s.calls.length, 0);
  });
  await check("an oversized download is reported as an error and leaves nothing behind", async () => {
    globalThis.fetch = script(ok("x".repeat(50), { "content-length": "50" })).impl;
    const prev = process.env.DOCTEST_FIXTURE_MAX_MB;
    process.env.DOCTEST_FIXTURE_MAX_MB = "0.00001"; // ~10 bytes
    const r = await prepareFixtures(["https://example.com/big.csv"]);
    if (prev === undefined) delete process.env.DOCTEST_FIXTURE_MAX_MB; else process.env.DOCTEST_FIXTURE_MAX_MB = prev;
    try {
      assert.match(r.errors[0], /big\.csv.*limit/);
      assert.deepEqual(r.files, []);
    } finally { cleanupFixtures(r.dir); }
  });
} finally { globalThis.fetch = realFetch; }

console.log(failed ? `\n${failed} check(s) failed` : "\nall checks passed");
process.exit(failed ? 1 : 0);
