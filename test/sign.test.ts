// Guards for the signed head.
//
// A signature says WHO wrote a log, never that it is true. These tests are
// about the gap between "this signature is genuine" and "this signature is
// about the log in front of me" -- which is where signed-log designs usually
// fail, because checking the first feels like checking the second.

import test from "node:test";
import assert from "node:assert/strict";
import { generateKey, headPreimage, signHead, verifyHead } from "../src/sign.ts";
import { seal, type Reading, type ReadingContent } from "../src/reading.ts";

const content = (over: Partial<ReadingContent> = {}): ReadingContent => ({
  commitment: "c-1",
  verdict: "HELD",
  reason: "no outbound transfer in window",
  rpc: [
    { provider: "alpha", method: "eth_getLogs", params: [], result: [], at_block: 100 },
    { provider: "beta", method: "eth_getLogs", params: [], result: [], at_block: 100 },
  ],
  read_at: 1_700_000_000_000,
  ...over,
});

async function chainOf(n: number): Promise<Reading[]> {
  const out: Reading[] = [];
  let prev = "";
  for (let i = 0; i < n; i++) {
    const line = await seal(content({ read_at: 1_700_000_000_000 + i * 1000 }), prev);
    out.push(line);
    prev = line.hash;
  }
  return out;
}

test("a signed head verifies against the log it was taken from", async () => {
  const pair = await generateKey();
  const lines = await chainOf(3);
  const sh = await signHead(lines, pair, 1_700_000_100_000);
  assert.deepEqual(await verifyHead(lines, sh), { ok: true });
  assert.equal(sh.count, 3);
  assert.equal(sh.head, lines[2]!.hash);
});

test("a signature taken over a longer log does not verify a truncated one", async () => {
  // Truncation is caught by the explicit count comparison in verifyHead, and
  // by the head comparison beside it. Both are checked here.
  //
  // Killing mutation: delete the `sh.count !== lines.length` branch. This goes
  // red on the first assertion; the head check then catches it instead, which
  // is why the second assertion exists.
  //
  // NOT claimed: that `count` inside the SIGNATURE does this work. It does not
  // -- see the note on headPreimage. An earlier version of this test asserted
  // a forged restamp fails on bad_signature, which it does, but only because
  // the restamp also had to change the head. That made it a test of the head
  // binding wearing a count-binding label.
  const pair = await generateKey();
  const full = await chainOf(5);
  const sh = await signHead(full, pair, 1_700_000_100_000);
  const truncated = full.slice(0, 3);

  const r = await verifyHead(truncated, sh);
  assert.equal(r.ok, false);
  assert.equal(r.problem, "count_mismatch");

  // Even with the count edited to match, the head does not.
  const restamped = { ...sh, count: 3 };
  const r2 = await verifyHead(truncated, restamped);
  assert.equal(r2.ok, false);
  assert.ok(r2.problem === "head_mismatch" || r2.problem === "bad_signature");
});

test("a genuine signature about a DIFFERENT log is rejected", async () => {
  // "The signature is valid" is not the question a reader means to ask. This
  // is the case where checking only the crypto passes and the answer is wrong.
  //
  // Killing mutation: return { ok: true } as soon as the signature verifies.
  // This goes red, and so does the truncation test above.
  const pair = await generateKey();
  const a = await chainOf(3);
  const b = await chainOf(3);
  b[2] = await seal(content({ read_at: 999_999 }), b[1]!.hash); // same length, different head
  const sh = await signHead(a, pair, 1_700_000_100_000);
  const r = await verifyHead(b, sh);
  assert.equal(r.ok, false);
  assert.equal(r.problem, "head_mismatch");
});

test("a forged signature is rejected", async () => {
  const mine = await generateKey();
  const theirs = await generateKey();
  const lines = await chainOf(2);
  const sh = await signHead(lines, mine, 1_700_000_100_000);
  // Someone else's key, claiming the same head.
  const forged = { ...sh, key: (await signHead(lines, theirs, 1_700_000_100_000)).key };
  const r = await verifyHead(lines, forged);
  assert.equal(r.ok, false);
  assert.equal(r.problem, "bad_signature");
});

test("a tampered signature is rejected", async () => {
  const pair = await generateKey();
  const lines = await chainOf(2);
  const sh = await signHead(lines, pair, 1_700_000_100_000);
  const flipped = sh.sig.slice(0, -4) + (sh.sig.endsWith("AAAA") ? "BBBB" : "AAAA");
  const r = await verifyHead(lines, { ...sh, sig: flipped });
  assert.equal(r.ok, false);
  assert.equal(r.problem, "bad_signature");
});

test("signed_at is covered, so two heads over the same log are distinguishable", async () => {
  // Same log, two different times, are two different statements about when the
  // operator last looked. If signed_at were outside the signature, one could be
  // restamped to claim a fresher reading than was taken.
  //
  // Killing mutation: drop signed_at from headPreimage. This goes red.
  const pair = await generateKey();
  const lines = await chainOf(2);
  const early = await signHead(lines, pair, 1_000);
  const restamped = { ...early, signed_at: 999_999_999 };
  const r = await verifyHead(lines, restamped);
  assert.equal(r.ok, false);
  assert.equal(r.problem, "bad_signature");
});

test("an unusable key is reported, not thrown", async () => {
  // A malformed key in a published head is someone else's bug, and a verifier
  // that crashes on it cannot report on the log at all.
  const pair = await generateKey();
  const lines = await chainOf(1);
  const sh = await signHead(lines, pair, 1_000);
  const r = await verifyHead(lines, { ...sh, key: "not-a-key" });
  assert.equal(r.ok, false);
  assert.equal(r.problem, "unusable_key");
});

test("an empty log can be signed and verified", async () => {
  // A fresh deployment that has looked at nothing yet can still publish a head
  // saying so, which is more useful than publishing nothing.
  const pair = await generateKey();
  const sh = await signHead([], pair, 1_000);
  assert.equal(sh.head, "");
  assert.equal(sh.count, 0);
  assert.deepEqual(await verifyHead([], sh), { ok: true });
  assert.equal((await verifyHead(await chainOf(1), sh)).problem, "count_mismatch");
});

test("the preimage is domain-separated", async () => {
  // Without a tag, a head signature could be replayed as a signature over some
  // other structure that happens to canonicalise the same way.
  assert.match(headPreimage("abc", 1, 2), /1f512\.head\.v1/);
});
