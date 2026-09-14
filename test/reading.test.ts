// Guards for the reading record (issue #2).
//
// Each test names the mutation that kills it. A test that passes whether or not
// the behaviour exists is not a test, and this project's own filing rule says
// the same thing about commitments: a check that could not have failed is not a
// check. So the merge bar is that someone applied the mutation and watched it
// go red, not that the suite was green.

import test from "node:test";
import assert from "node:assert/strict";
import {
  assertProviderLabel,
  canonical,
  preimage,
  seal,
  verifyChain,
  type Reading,
  type ReadingContent,
} from "../src/reading.ts";

function content(over: Partial<ReadingContent> = {}): ReadingContent {
  return {
    commitment: "c-1",
    verdict: "HELD",
    reason: "no outbound transfer in window",
    rpc: [
      { provider: "alpha", method: "eth_getLogs", params: [{ fromBlock: "0x1" }], result: [], at_block: 100 },
      { provider: "beta", method: "eth_getLogs", params: [{ fromBlock: "0x1" }], result: [], at_block: 100 },
    ],
    read_at: 1_700_000_000_000,
    ...over,
  };
}

test("canonical form does not depend on key order", () => {
  // Killing mutation: drop `.sort()` in canonical(). Two readers building the
  // same record from different code would then hash different bytes, and the
  // chain would break for no reason anyone could see.
  const a = canonical({ b: 1, a: 2, c: { z: 1, y: 2 } });
  const b = canonical({ c: { y: 2, z: 1 }, a: 2, b: 1 });
  assert.equal(a, b);
  assert.equal(a, '{"a":2,"b":1,"c":{"y":2,"z":1}}');
});

test("canonical form refuses a number that cannot survive a round trip", () => {
  // THE SILENT ONE. A chain quantity beyond 2^53 loses precision in JSON with
  // nothing raising, so the log would record a number that is not the number
  // the chain holds -- and it would be signed and hash-chained, which is to say
  // permanently and authoritatively wrong.
  //
  // Killing mutation: delete the isSafeInteger check. This goes red, and the
  // record silently starts accepting 10000000000000000001 as ...000.
  assert.throws(() => canonical(10_000_000_000_000_000_001), /safe integers/);
  assert.throws(() => canonical(1.5), /safe integers/);
  assert.throws(() => canonical(NaN), /non-finite/);
  // The correct way to carry one:
  assert.equal(canonical({ wei: "10000000000000000001" }), '{"wei":"10000000000000000001"}');
});

test("a provider must be a label, because an RPC URL carries an API key", () => {
  // Killing mutation: delete assertProviderLabel's URL check, or stop calling it
  // from seal(). This goes red -- and in production the log would publish a
  // keyed endpoint into an append-only public file, signed, forever.
  assertProviderLabel("alpha");
  assert.throws(() => assertProviderLabel("https://rpc.example/v2/SECRETKEY"), /not a URL/);
  assert.throws(() => assertProviderLabel("rpc.example/v2/KEY"), /not a URL/);
  assert.throws(() => assertProviderLabel(""), /short trimmed label/);
});

test("seal refuses a URL-shaped provider, so the check cannot be bypassed by the writer", async () => {
  // Killing mutation: remove the assertProviderLabel loop from seal(). The
  // label test above still passes, because it calls the helper directly. This
  // one goes red. Both exist because a guard nobody calls is not a guard.
  await assert.rejects(
    seal(content({ rpc: [{ provider: "https://rpc.example/KEY", method: "eth_call", params: [], result: null, at_block: 1 }] }), ""),
    /not a URL/,
  );
});

test("a line hashes over its content AND its predecessor", async () => {
  // Killing mutation: drop prev_hash from preimage(). This goes red. Without it
  // lines could be reordered or a line removed, and every remaining hash would
  // still verify -- the log would be append-only only by our say-so.
  const c = content();
  const a = await seal(c, "");
  const b = await seal(c, "deadbeef");
  assert.notEqual(a.hash, b.hash, "the same content under a different predecessor is a different line");
  assert.equal(preimage(c, "x") === preimage(c, "y"), false);
});

test("a stranger recomputes the hash from the published fields alone", async () => {
  // The whole point. Nothing secret, nothing implicit, no field held back.
  const c = content();
  const line = await seal(c, "");
  const { hash, prev_hash, ...published } = line;
  const recomputed = await crypto.subtle
    .digest("SHA-256", new TextEncoder().encode(preimage(published as ReadingContent, prev_hash)))
    .then((b) => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join(""));
  assert.equal(recomputed, hash);
});

test("verifyChain accepts a good chain and names every break in a bad one", async () => {
  // Killing mutation: make verifyChain return after its first problem. This
  // goes red on the two-break case. A verifier that stops at the first break
  // tells a reader the damage is smaller than it is.
  const l1 = await seal(content({ read_at: 1000 }), "");
  const l2 = await seal(content({ read_at: 2000, verdict: "BROKEN", reason: "outbound transfer seen" }), l1.hash);
  const l3 = await seal(content({ read_at: 3000 }), l2.hash);
  assert.deepEqual(await verifyChain([l1, l2, l3]), []);

  const tampered: Reading[] = [l1, { ...l2, reason: "nothing to see here" }, l3];
  const problems = await verifyChain(tampered);
  assert.ok(problems.some((p) => p.index === 1 && p.problem === "hash"), "the edited line fails its own hash");
  assert.ok(problems.some((p) => p.index === 2 && p.problem === "link"), "and every line after it is orphaned");
  assert.ok(problems.length >= 2, "both are reported, not just the first");
});

test("a reordered log is caught even when every hash is honest", async () => {
  // Killing mutation: delete the read_at ordering check. This goes red. It is
  // the case where someone rebuilds the chain correctly but out of time order,
  // so the hashes all verify and the history is still a lie.
  const l1 = await seal(content({ read_at: 5000 }), "");
  const l2 = await seal(content({ read_at: 1000 }), l1.hash);
  const problems = await verifyChain([l1, l2]);
  assert.ok(problems.some((p) => p.problem === "order"), "time going backwards is reported");
});

test("UNREADABLE is a first-class verdict, not an error", async () => {
  // The proposal: "two RPCs; disagreement or failure is UNREADABLE and is
  // published, never defaulted to HELD." A format that only encodes the happy
  // path pushes the failure into prose, where nothing can check it.
  const line = await seal(
    content({
      verdict: "UNREADABLE",
      reason: "providers disagreed",
      rpc: [
        { provider: "alpha", method: "eth_getLogs", params: [], result: [{ tx: "0xa" }], at_block: 100 },
        { provider: "beta", method: "eth_getLogs", params: [], result: [], at_block: 100 },
      ],
    }),
    "",
  );
  assert.equal(line.verdict, "UNREADABLE");
  assert.equal(line.rpc.length, 2, "and both disagreeing answers are kept, not one of them picked");
});
