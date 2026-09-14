// Guards for two-RPC agreement (issue #3).
//
// Each test names the mutation that kills it, and the mutation was run.

import test from "node:test";
import assert from "node:assert/strict";
import { agree, toExchanges, verdictFor, type Attempt } from "../src/agreement.ts";

const ok = (provider: string, result: unknown, at_block = 100): Attempt => ({ provider, ok: true, result, at_block });
const fail = (provider: string, error = "timeout"): Attempt => ({ provider, ok: false, error });

test("BOTH READS FAILING IS UNREADABLE, NEVER HELD", () => {
  // The test this file exists for, written first on purpose. A watcher that
  // cannot see the chain and reports "nothing looked broken" manufactures
  // evidence of a promise being kept out of its own blindness.
  //
  // Killing mutation: in agree(), return an agreed:true result when
  // answered.length === 0 (or remove the all_failed branch and let the later
  // `allSame` check pass vacuously over an empty array -- note that
  // [].every() is TRUE, so deleting this branch does NOT throw, it silently
  // agrees. That is exactly how this defect ships.)
  const a = agree([fail("alpha"), fail("beta")]);
  assert.equal(a.agreed, false);
  assert.equal(a.reason, "all_failed");
  assert.equal(verdictFor(a), "UNREADABLE");
  assert.equal(a.result, undefined, "no result is invented from nothing");
});

test("one provider failing is UNREADABLE, not the survivor's answer", () => {
  // Killing mutation: change the `answered.length < attempts.length` branch to
  // fall through. The surviving read becomes the answer and the log records a
  // single-sourced verdict as if two had agreed.
  const a = agree([ok("alpha", []), fail("beta")]);
  assert.equal(a.agreed, false);
  assert.equal(a.reason, "one_failed");
  assert.equal(verdictFor(a), "UNREADABLE");
});

test("a disagreement keeps BOTH answers rather than picking one", () => {
  // Killing mutation: return only the first answer in attempts. The evidence
  // that they differed -- the only thing that makes the verdict checkable --
  // is destroyed at the moment it matters.
  const a = agree([ok("alpha", [{ tx: "0xa" }]), ok("beta", [])]);
  assert.equal(a.agreed, false);
  assert.equal(a.reason, "disagreed");
  assert.equal(a.attempts.length, 2);
  assert.deepEqual((a.attempts[0] as { result: unknown }).result, [{ tx: "0xa" }]);
  assert.deepEqual((a.attempts[1] as { result: unknown }).result, []);
});

test("the same provider twice is not agreement", () => {
  // THE CHEAPEST MISTAKE HERE, and the hardest to see afterwards: the record
  // looks like consensus. One wrong node, one stale cache, one compromised
  // host answers both requests and the log says two sources agreed.
  //
  // Killing mutation: delete the labels.size check. This goes red.
  const a = agree([ok("alpha", []), ok("alpha", [])]);
  assert.equal(a.agreed, false);
  assert.equal(a.reason, "same_provider_twice");
});

test("one provider is never enough", () => {
  // Killing mutation: change `attempts.length < 2` to `< 1`.
  assert.equal(agree([ok("alpha", [])]).reason, "too_few_providers");
  assert.equal(agree([]).reason, "too_few_providers");
});

test("agreement is by value, not by key order", () => {
  // Two providers serialising the same object differently is routine. Calling
  // that a disagreement would make the log useless -- every reading UNREADABLE,
  // and the UNREADABLE count is the number the project is judged on.
  //
  // Killing mutation: compare with JSON.stringify instead of canonical().
  const a = agree([ok("alpha", { b: 1, a: 2 }), ok("beta", { a: 2, b: 1 })]);
  assert.equal(a.agreed, true);
  assert.deepEqual(a.result, { b: 1, a: 2 });
});

test("agreeing about different blocks is not agreement", () => {
  // Two providers can return identical logs for different heights; that is two
  // facts that happen to look alike, not one fact confirmed twice.
  //
  // Killing mutation: delete the blocks.size check. This goes red.
  const a = agree([ok("alpha", [], 100), ok("beta", [], 101)]);
  assert.equal(a.agreed, false);
  assert.equal(a.reason, "disagreed");
});

test("an agreed read yields a result, a block, and no verdict of its own", () => {
  // verdictFor returns null on agreement: this module decides readability, it
  // does NOT decide HELD or BROKEN. That is the predicate's job, and conflating
  // them is how a monitor starts answering questions it was never asked.
  //
  // Killing mutation: have verdictFor return "HELD" when agreed.
  const a = agree([ok("alpha", [], 100), ok("beta", [], 100)]);
  assert.equal(a.agreed, true);
  assert.equal(a.at_block, 100);
  assert.equal(verdictFor(a), null);
});

test("exchanges published from an agreement carry every answering provider", () => {
  const a = agree([ok("alpha", [], 100), ok("beta", [], 100)]);
  const ex = toExchanges("eth_getLogs", [{ fromBlock: "0x1" }], a);
  assert.equal(ex.length, 2);
  assert.deepEqual(ex.map((e) => e.provider), ["alpha", "beta"]);
  assert.equal(ex[0]!.method, "eth_getLogs");
});
