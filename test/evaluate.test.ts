// Guards for the read-path clock (issue #4).
//
// The design constraint: state is a pure function of (row, chain, T). The test
// that proves it is the one where a commitment reads DEFAULTED with no writer
// having run at any point -- and the one where the same inputs at the same T
// always give the same answer.

import test from "node:test";
import assert from "node:assert/strict";
import { evaluate } from "../src/evaluate.ts";
import type { ChainState, Commitment, Transfer } from "../src/commitment.ts";

const SUBJ = "0x" + "aa".repeat(20);
const OTHER = "0x" + "11".repeat(20);
const TOKEN = "0x" + "bb".repeat(20);
const FROM = 1_700_000_000_000;
const HOUR = 3_600_000;
const WINDOW = { from: FROM, to: FROM + 30 * 86_400_000 };

const chain = (over: Partial<ChainState> = {}): ChainState => ({
  at_block: 100,
  at_time: FROM,
  transfers: [],
  balances: {},
  ...over,
});

const xfer = (over: Partial<Transfer> = {}): Transfer => ({
  tx: "0x" + "22".repeat(32),
  from: SUBJ,
  to: OTHER,
  token: TOKEN,
  value: "1",
  at_block: 101,
  at_time: FROM + HOUR,
  ...over,
});

const noOut: Commitment = {
  id: "c-1",
  predicate: { kind: "no-outbound-transfer", subject: SUBJ, token: TOKEN },
  window: WINDOW,
};

test("DEFAULTED with no writer having run at any point", () => {
  // THE TEST THAT PROVES THE DESIGN. Nothing wrote a status anywhere. The
  // verdict is computed from the stored row, the chain state, and T alone.
  //
  // Killing mutation: read the current time instead of T inside evaluate().
  // The verdict then depends on when the process happens to be running, which
  // is exactly the dependency the read-path clock exists to remove.
  const c: Commitment = {
    id: "c-2",
    predicate: { kind: "disclosed-within", subject: SUBJ, token: TOKEN, hours: 6 },
    window: WINDOW,
  };
  const out = xfer();
  const state = chain({ transfers: [out], disclosures: {} });

  // Before the deadline: not a break yet. The window they were given still runs.
  const early = evaluate(c, state, out.at_time + 5 * HOUR);
  assert.equal(early.verdict, "HELD");

  // After it: DEFAULTED, with no writer involved at any point.
  const late = evaluate(c, state, out.at_time + 7 * HOUR);
  assert.equal(late.verdict, "DEFAULTED");
  assert.match(late.reason, /never disclosed/);
});

test("the same inputs at the same T always give the same verdict", () => {
  // Killing mutation: introduce any Date.now(), Math.random(), or mutable
  // module state. Ten evaluations must be identical.
  const c: Commitment = {
    id: "c-3",
    predicate: { kind: "disclosed-within", subject: SUBJ, token: TOKEN, hours: 6 },
    window: WINDOW,
  };
  const state = chain({ transfers: [xfer()], disclosures: {} });
  const T = xfer().at_time + 7 * HOUR;
  const seen = new Set(Array.from({ length: 10 }, () => JSON.stringify(evaluate(c, state, T))));
  assert.equal(seen.size, 1, "deterministic");
});

test("advancing T across the deadline flips the verdict with nothing else changing", () => {
  // The clock IS the only moving part. Same row, same chain, different T.
  const c: Commitment = {
    id: "c-4",
    predicate: { kind: "disclosed-within", subject: SUBJ, token: TOKEN, hours: 2 },
    window: WINDOW,
  };
  const out = xfer();
  const state = chain({ transfers: [out], disclosures: {} });
  const deadline = out.at_time + 2 * HOUR;
  assert.equal(evaluate(c, state, deadline).verdict, "HELD", "at the deadline, still inside it");
  assert.equal(evaluate(c, state, deadline + 1).verdict, "DEFAULTED", "one millisecond later, not");
});

test("a disclosure that arrived in time is not a default", () => {
  const c: Commitment = {
    id: "c-5",
    predicate: { kind: "disclosed-within", subject: SUBJ, token: TOKEN, hours: 6 },
    window: WINDOW,
  };
  const out = xfer();
  const state = chain({ transfers: [out], disclosures: { [out.tx]: { at_time: out.at_time + HOUR } } });
  assert.equal(evaluate(c, state, out.at_time + 100 * HOUR).verdict, "HELD");
});

test("a disclosure that arrived LATE is still a default", () => {
  // Killing mutation: accept any disclosure regardless of its timestamp. The
  // predicate becomes "disclosed eventually", which is not what was promised.
  const c: Commitment = {
    id: "c-6",
    predicate: { kind: "disclosed-within", subject: SUBJ, token: TOKEN, hours: 6 },
    window: WINDOW,
  };
  const out = xfer();
  const state = chain({ transfers: [out], disclosures: { [out.tx]: { at_time: out.at_time + 9 * HOUR } } });
  const r = evaluate(c, state, out.at_time + 10 * HOUR);
  assert.equal(r.verdict, "DEFAULTED");
  assert.match(r.reason, /after the deadline/);
});

test("a break is BROKEN regardless of when you read it", () => {
  // A break that happened does not un-happen because the page loaded later.
  const state = chain({ transfers: [xfer()] });
  for (const T of [FROM, FROM + 86_400_000, FROM + 10 * 365 * 86_400_000]) {
    assert.equal(evaluate(noOut, state, T).verdict, "BROKEN", `still broken at T=${T}`);
  }
});

test("a transfer outside the window is not a break of THIS commitment", () => {
  // Killing mutation: drop the inWindow filter. Every historical transfer the
  // subject ever made becomes a break of a commitment made afterwards.
  const before = xfer({ at_time: WINDOW.from - HOUR });
  const after = xfer({ at_time: WINDOW.to + HOUR });
  assert.equal(evaluate(noOut, chain({ transfers: [before] }), WINDOW.to).verdict, "HELD");
  assert.equal(evaluate(noOut, chain({ transfers: [after] }), WINDOW.to + 2 * HOUR).verdict, "HELD");
});

test("an inbound transfer is not an outbound one", () => {
  const inbound = xfer({ from: OTHER, to: SUBJ });
  assert.equal(evaluate(noOut, chain({ transfers: [inbound] }), WINDOW.to).verdict, "HELD");
});

test("a different token is a different promise", () => {
  const otherToken = xfer({ token: "0x" + "cc".repeat(20) });
  assert.equal(evaluate(noOut, chain({ transfers: [otherToken] }), WINDOW.to).verdict, "HELD");
});

test("A MISSING BALANCE IS UNREADABLE, NOT ZERO", () => {
  // Absence of a derivation is not proof of zero. Reading a missing balance as
  // 0 would publish BROKEN against someone whose balance we merely failed to
  // fetch -- a false accusation, permanently, in an append-only log.
  //
  // Killing mutation: default the balance to "0" when absent. This goes red
  // and the registry starts accusing people of breaking promises it could not
  // read.
  const c: Commitment = {
    id: "c-7",
    predicate: { kind: "balance-floor", subject: SUBJ, token: TOKEN, floor: "1000" },
    window: WINDOW,
  };
  const r = evaluate(c, chain({ balances: {} }), WINDOW.to);
  assert.equal(r.verdict, "UNREADABLE");
  assert.match(r.reason, /no balance/);
});

test("balance comparison is by magnitude, not string order", () => {
  // Killing mutation: compare balances with < on the strings. "9" < "1000" is
  // false lexically, so a healthy balance reads as a break.
  const c: Commitment = {
    id: "c-8",
    predicate: { kind: "balance-floor", subject: SUBJ, token: TOKEN, floor: "1000" },
    window: WINDOW,
  };
  assert.equal(evaluate(c, chain({ balances: { [SUBJ]: "9999" } }), WINDOW.to).verdict, "HELD");
  assert.equal(evaluate(c, chain({ balances: { [SUBJ]: "999" } }), WINDOW.to).verdict, "BROKEN");
});

test("only-to permits the allowlist and catches everything else", () => {
  const c: Commitment = {
    id: "c-9",
    predicate: { kind: "only-to", subject: SUBJ, token: TOKEN, allowed: [OTHER] },
    window: WINDOW,
  };
  assert.equal(evaluate(c, chain({ transfers: [xfer({ to: OTHER })] }), WINDOW.to).verdict, "HELD");
  const stranger = "0x" + "dd".repeat(20);
  const r = evaluate(c, chain({ transfers: [xfer({ to: stranger })] }), WINDOW.to);
  assert.equal(r.verdict, "BROKEN");
  assert.equal((r.evidence as Transfer).to, stranger, "the evidence names where it went");
});

test("an unknown predicate kind is UNREADABLE, never HELD", () => {
  // "I do not know what this commitment means" must never look like "this
  // commitment is being kept".
  const c = { id: "c-10", predicate: { kind: "vibes", subject: SUBJ, token: null }, window: WINDOW } as never as Commitment;
  assert.equal(evaluate(c, chain(), WINDOW.to).verdict, "UNREADABLE");
});

test("the reason distinguishes a window still running from one that closed", () => {
  assert.match(evaluate(noOut, chain(), WINDOW.from + HOUR).reason, /window open/);
  assert.match(evaluate(noOut, chain(), WINDOW.to).reason, /window closed/);
});

test("balance exactly at the floor is HELD, not BROKEN", () => {
  // Killing mutation: cmpDec(bal, p.floor) <= 0 instead of < 0.
  // A balance that precisely equals the promised floor is kept, not broken.
  // Accusing someone whose balance meets their promise is a false accusation.
  const c: Commitment = {
    id: "c-floor-exact",
    predicate: { kind: "balance-floor", subject: SUBJ, token: TOKEN, floor: "1000" },
    window: WINDOW,
  };
  assert.equal(evaluate(c, chain({ balances: { [SUBJ]: "1000" } }), WINDOW.to).verdict, "HELD");
});

test("window boundaries: transfer at exact start breaks, transfer at exact end is outside", () => {
  // Killing mutations:
  // 1. t >= c.window.from -> t > c.window.from (escapes at window.from)
  // 2. t < c.window.to -> t <= c.window.to (falsely caught at window.to)
  const atStart = xfer({ at_time: WINDOW.from });
  const atEnd = xfer({ at_time: WINDOW.to });

  // A transfer at the first instant of the window MUST be caught as a break
  assert.equal(evaluate(noOut, chain({ transfers: [atStart] }), WINDOW.to).verdict, "BROKEN", "transfer at exact window.from breaks");

  // A transfer at the closing instant of the window MUST NOT be caught (window is [from, to))
  assert.equal(evaluate(noOut, chain({ transfers: [atEnd] }), WINDOW.to + HOUR).verdict, "HELD", "transfer at exact window.to is outside");
});

test("a disclosure filed exactly at the deadline is on time", () => {
  // Killing mutation: d.at_time < t.at_time + deadlineMs instead of <=.
  // A disclosure filed right on the deadline is within the promised window,
  // not a default.
  const c: Commitment = {
    id: "c-deadline-exact",
    predicate: { kind: "disclosed-within", subject: SUBJ, token: TOKEN, hours: 6 },
    window: WINDOW,
  };
  const out = xfer();
  const deadline = out.at_time + 6 * HOUR;
  const state = chain({ transfers: [out], disclosures: { [out.tx]: { at_time: deadline } } });
  assert.equal(evaluate(c, state, deadline + 10 * HOUR).verdict, "HELD", "disclosure on the deadline is HELD");
});
