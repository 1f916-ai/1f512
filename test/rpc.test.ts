// Guards for the RPC client.
//
// This is the only file that talks to the network, so the tests are about what
// it refuses and what it never records, not about happy-path plumbing.

import test from "node:test";
import assert from "node:assert/strict";
import { ask, askBoth, scrub, type FetchLike, type Provider } from "../src/rpc.ts";

const KEYED_URL = "https://rpc.example.com/v2/SUPERSECRETAPIKEY0123456789";
const ALPHA: Provider = { label: "alpha", url: KEYED_URL };
const BETA: Provider = { label: "beta", url: "https://other.example.com/rpc" };

function stub(handler: (body: unknown) => { ok?: boolean; status?: number; json: unknown }): FetchLike {
  return async (_url, init) => {
    const r = handler(JSON.parse(init.body));
    return { ok: r.ok ?? true, status: r.status ?? 200, json: async () => r.json };
  };
}

test("a good answer carries the result and the pinned block", async () => {
  const a = await ask(ALPHA, { method: "eth_getLogs", params: [] }, 500, {
    fetchImpl: stub(() => ({ json: { jsonrpc: "2.0", id: 1, result: [{ tx: "0xa" }] } })),
  });
  assert.equal(a.ok, true);
  assert.equal(a.provider, "alpha");
  assert.equal(a.ok && a.at_block, 500);
});

test("A JSON-RPC ERROR BESIDE A RESULT IS AN ERROR", async () => {
  // A provider returning both is telling you it failed and handing you
  // something anyway. Taking the something is how a bad answer becomes a
  // published verdict.
  //
  // Killing mutation: check `result` before `error`. This goes red.
  const a = await ask(ALPHA, { method: "eth_call", params: [] }, 1, {
    fetchImpl: stub(() => ({ json: { jsonrpc: "2.0", id: 1, result: "0xdeadbeef", error: { message: "reverted" } } })),
  });
  assert.equal(a.ok, false);
  assert.match(a.ok === false ? a.error : "", /reverted/);
});

test("a response with neither result nor error is a failure, not an undefined result", async () => {
  // Killing mutation: return ok:true with result undefined. The log then
  // records `undefined` as a chain answer and two providers "agree" on it.
  const a = await ask(ALPHA, { method: "eth_call", params: [] }, 1, {
    fetchImpl: stub(() => ({ json: { jsonrpc: "2.0", id: 1 } })),
  });
  assert.equal(a.ok, false);
  assert.match(a.ok === false ? a.error : "", /neither result nor error/);
});

test("THE API KEY NEVER REACHES AN ERROR MESSAGE", async () => {
  // The leak this file exists to prevent. Provider error text routinely echoes
  // the request URL back, and this log is append-only, signed and public.
  //
  // Killing mutation: return String(e) without scrub(). This goes red and the
  // key ships to a permanent public record.
  const a = await ask(ALPHA, { method: "eth_call", params: [] }, 1, {
    fetchImpl: async () => {
      throw new Error(`connect ECONNREFUSED for ${KEYED_URL}`);
    },
  });
  assert.equal(a.ok, false);
  const err = a.ok === false ? a.error : "";
  assert.doesNotMatch(err, /SUPERSECRETAPIKEY/, "the key is gone");
  assert.doesNotMatch(err, /rpc\.example\.com/, "so is the host");
});

test("scrub removes the url, the host, and any long path segment", () => {
  const t = scrub(`failed calling ${KEYED_URL} (host rpc.example.com)`, KEYED_URL);
  assert.doesNotMatch(t, /SUPERSECRETAPIKEY/);
  assert.doesNotMatch(t, /rpc\.example\.com/);
  assert.ok(t.length <= 200, "and the result is bounded");
});

test("scrub bounds even a malformed configured url", () => {
  const long = "x".repeat(5000);
  assert.ok(scrub(long, "not a url").length <= 200);
});

test("an http failure is recorded without the url", async () => {
  const a = await ask(ALPHA, { method: "eth_call", params: [] }, 1, {
    fetchImpl: stub(() => ({ ok: false, status: 429, json: {} })),
  });
  assert.equal(a.ok, false);
  assert.match(a.ok === false ? a.error : "", /http 429/);
});

test("a URL-shaped label is refused before any request is made", async () => {
  // Killing mutation: drop the assertProviderLabel call. A misconfigured
  // provider then publishes its own keyed URL as the provider name.
  await assert.rejects(
    ask({ label: KEYED_URL, url: KEYED_URL }, { method: "eth_call", params: [] }, 1, {
      fetchImpl: stub(() => ({ json: { result: null } })),
    }),
    /not a URL/,
  );
});

test("askBoth refuses two providers with the same label", async () => {
  // Refused here AND in agreement.ts. A caller that configures the same
  // provider twice has made a mistake that produces a log claiming consensus;
  // it should fail at the mistake, not quietly at the record.
  //
  // Killing mutation: delete the label check. This goes red.
  await assert.rejects(
    askBoth([ALPHA, { label: "alpha", url: BETA.url }], { method: "eth_call", params: [] }, 1, {
      fetchImpl: stub(() => ({ json: { result: null } })),
    }),
    /two DIFFERENT providers/,
  );
});

test("askBoth pins both questions to the same block", async () => {
  // Two providers asked "what is it now" answer about different heights and
  // disagree for reasons that have nothing to do with the commitment.
  const seen: number[] = [];
  const attempts = await askBoth([ALPHA, BETA], { method: "eth_getLogs", params: [{ fromBlock: "0x1" }] }, 777, {
    fetchImpl: async (_u, init) => {
      const b = JSON.parse(init.body);
      seen.push(b.params.length);
      return { ok: true, status: 200, json: async () => ({ result: [] }) };
    },
  });
  assert.equal(attempts.length, 2);
  assert.ok(attempts.every((a) => a.ok && a.at_block === 777), "both pinned to 777");
});

test("one provider failing does not prevent the other's answer being recorded", async () => {
  // The failure is data. agreement.ts decides what it means; this just has to
  // deliver both outcomes intact.
  const attempts = await askBoth([ALPHA, BETA], { method: "eth_call", params: [] }, 9, {
    fetchImpl: async (url) =>
      url === ALPHA.url
        ? Promise.reject(new Error("boom"))
        : { ok: true, status: 200, json: async () => ({ result: "0x1" }) },
  });
  assert.equal(attempts.filter((a) => a.ok).length, 1);
  assert.equal(attempts.filter((a) => !a.ok).length, 1);
});
