// The bracket builder: reading rows in, Disclosure brackets out (issue #31).
//
// The property under test: the bracket NEVER claims more than the rows prove.
// A bound that is not the at_time of a supplied row, or a crooked channel
// smoothed into a clean story, is the builder deciding what only the verdict
// set may decide.

import test from "node:test";
import assert from "node:assert/strict";
import { buildBrackets, type Sighting } from "../src/bracket.ts";
import { evaluate } from "../src/evaluate.ts";
import type { ChainState, Commitment, Transfer } from "../src/commitment.ts";

const TX = "0x" + "22".repeat(32);
const TX2 = "0x" + "33".repeat(32);
const T0 = 1_700_000_000_000;
const HOUR = 3_600_000;

const row = (at_time: number, disclosed: string[] = [], claimed?: Record<string, number>): Sighting => ({
  at_time,
  disclosed,
  ...(claimed ? { claimed } : {}),
});

test("a clean transition brackets with the TIGHTEST absent row, not the first", () => {
  // Rows without it at +1h, +2h, +3h; first row with it at +5h. The last row
  // that lacked it is +3h, and that is the bound the contract names.
  //
  // Killing mutation: take the FIRST absent row. The bracket widens from
  // (3h, 5h] to (1h, 5h]. Against a deadline at +2h the tight bracket convicts
  // (a chained row at +3h still lacked it), the wide one straddles: the
  // mutation turns provably-late cases into UNREADABLE, the instrument
  // reporting itself blind where it could see.
  const { disclosures, anomalies } = buildBrackets([
    row(T0 + HOUR),
    row(T0 + 2 * HOUR),
    row(T0 + 3 * HOUR),
    row(T0 + 5 * HOUR, [TX]),
    row(T0 + 6 * HOUR, [TX]),
  ]);
  assert.deepEqual(disclosures[TX], { absent_at: T0 + 3 * HOUR, present_at: T0 + 5 * HOUR });
  assert.equal(anomalies.length, 0);
});

test("a disclosure carried by the first row was never observed absent", () => {
  const { disclosures } = buildBrackets([row(T0, [TX]), row(T0 + HOUR, [TX])]);
  assert.deepEqual(disclosures[TX], { absent_at: null, present_at: T0 });
});

test("a tx never sighted gets NO entry, not an empty one", () => {
  // evaluate() reads a missing entry through chain.at_time (a stale snapshot
  // never proves silence). An entry with a null present_at would have to lie
  // in one direction or the other.
  const { disclosures } = buildBrackets([row(T0), row(T0 + HOUR)]);
  assert.deepEqual(disclosures, {});
});

test("A FLAPPING CHANNEL IS REPORTED, NEVER SMOOTHED", () => {
  // Carried at +2h, gone at +3h, back at +4h. The literal contract pair is
  // (last without = +3h, first with = +2h): out of order, exactly what the
  // rows say, and evaluate() refuses it as malformed rather than letting a
  // channel that contradicts itself prove anything.
  //
  // Killing mutation: bracket the first clean transition and drop the flap.
  // The builder would then be quietly deciding, off the record, that the
  // disappearance did not matter.
  const { disclosures, anomalies } = buildBrackets([
    row(T0 + HOUR),
    row(T0 + 2 * HOUR, [TX]),
    row(T0 + 3 * HOUR),
    row(T0 + 4 * HOUR, [TX]),
  ]);
  assert.deepEqual(disclosures[TX], { absent_at: T0 + 3 * HOUR, present_at: T0 + 2 * HOUR });
  assert.equal(anomalies.length, 1);
  assert.equal(anomalies[0]!.tx, TX);
  assert.equal(anomalies[0]!.problem, "flap");

  // And the refusal downstream actually happens: wire the bracket into a
  // chain state and the verdict is UNREADABLE/malformed, not HELD, not
  // DEFAULTED.
  const out: Transfer = {
    tx: TX,
    from: "0x" + "aa".repeat(20),
    to: "0x" + "11".repeat(20),
    token: "0x" + "bb".repeat(20),
    value: "1",
    at_block: 101,
    at_time: T0,
  };
  const c: Commitment = {
    id: "c-flap",
    predicate: { kind: "disclosed-within", subject: out.from, token: out.token, hours: 6 },
    window: { from: T0 - HOUR, to: T0 + 720 * HOUR },
  };
  const state: ChainState = {
    at_block: 100,
    at_time: T0 + 10 * HOUR,
    transfers: [out],
    balances: {},
    disclosures,
  };
  const r = evaluate(c, state, T0 + 10 * HOUR);
  assert.equal(r.verdict, "UNREADABLE");
  assert.match(r.reason, /malformed/);
});

test("claimed_at rides along from the first carrying row, as testimony", () => {
  const { disclosures } = buildBrackets([
    row(T0),
    row(T0 + HOUR, [TX], { [TX]: T0 + 10 }),
    row(T0 + 2 * HOUR, [TX], { [TX]: T0 + 999 }), // a later, different claim does not rewrite it
  ]);
  assert.deepEqual(disclosures[TX], { absent_at: T0, present_at: T0 + HOUR, claimed_at: T0 + 10 });
});

test("independent txs bracket independently", () => {
  const { disclosures, anomalies } = buildBrackets([
    row(T0, [TX2]),
    row(T0 + HOUR),
    row(T0 + 2 * HOUR, [TX, TX2]),
  ]);
  assert.deepEqual(disclosures[TX], { absent_at: T0 + HOUR, present_at: T0 + 2 * HOUR });
  // TX2 flaps (carried at T0, gone at +1h, back at +2h) and is reported.
  assert.deepEqual(disclosures[TX2], { absent_at: T0 + HOUR, present_at: T0 });
  assert.deepEqual(anomalies.map((a) => a.tx), [TX2]);
});

test("out-of-order sightings are refused, not sorted", () => {
  // Rows come from the watcher's own verified chain, where out-of-order
  // read_at already means "rewritten log". Sorting here would tidy the one
  // symptom the verifier reports.
  assert.throws(() => buildBrackets([row(T0 + HOUR), row(T0)]), /out of order/);
});

test("equal at_times are tolerated in the walk and refused by the verdict", () => {
  // Two rows in the same millisecond, one without and one with: the bracket
  // collapses to absent_at === present_at, which evaluate() treats as
  // malformed. The builder's job is to report what the rows say, and what
  // they say here is too thin to decide on.
  //
  // It is NOT a flap: nothing contradicted itself, the rows are just too close.
  // Killing mutation: label every absent_at >= present_at as "flap".
  const { disclosures, anomalies } = buildBrackets([row(T0), row(T0, [TX])]);
  assert.deepEqual(disclosures[TX], { absent_at: T0, present_at: T0 });
  assert.deepEqual(
    anomalies.map((a) => [a.tx, a.problem]),
    [[TX, "same-instant"]],
  );
});

test("carried then lacking inside ONE millisecond is still a flap", () => {
  // Same at_times as the test above, opposite row order. The pair is identical
  // (T0, T0), so no comparison of at_times can tell these apart; only the row
  // order can, and here the channel did contradict itself.
  // Killing mutation: decide flap by `absent_at > present_at`.
  const { disclosures, anomalies } = buildBrackets([row(T0, [TX]), row(T0)]);
  assert.deepEqual(disclosures[TX], { absent_at: T0, present_at: T0 });
  assert.deepEqual(
    anomalies.map((a) => [a.tx, a.problem]),
    [[TX, "flap"]],
  );
});
