// Guards for block coverage (issue #15).
//
// Each test names the mutation that kills it, and the mutation was run.
//
// The first test is the one the issue asks for by name. It is written first for
// the same reason agreement.test.ts writes its own first: it is the failure the
// file exists to prevent, and everything else here is scaffolding around it.

import test from "node:test";
import assert from "node:assert/strict";
import {
  advance,
  ceiling,
  coverageCheck,
  fallingBehind,
  gap,
  newCoverage,
  plan,
  type ProviderLimit,
} from "../src/coverage.ts";

const PROVIDERS: ProviderLimit[] = [
  { label: "alpha", maxRange: 10 },
  { label: "beta", maxRange: 5 },
];
const REQUIRED = ["alpha", "beta"];

test("A PROVIDER CAPPED BELOW THE GAP MUST NOT YIELD HELD", () => {
  // THE TEST THIS FILE EXISTS FOR, quoted from issue #15: "A test where the
  // provider caps the range below the gap, and the watcher is asked for a
  // verdict: it must not return HELD."
  //
  // Blocks 1000..1200 inclusive is 201 blocks. The tightest provider serves 5
  // at a time and the cycle is allowed 3 requests, so 1000..1014 is covered and
  // 1015..1200 -- 186 blocks -- is not. The watcher is then asked about the tip.
  //
  // (That 186 was 185 when this test was first written: an inclusive interval
  // counted as if it were half-open. The implementation was right and the
  // expectation was wrong, which is the direction worth recording -- a test
  // written to a mis-derived number would have been "fixed" by loosening
  // gap() until it agreed.)
  //
  // Killing mutation: delete the coverage tracking -- i.e. make coverageCheck
  // return `{covered: true}` unconditionally, or let advance() jump
  // covered_through to the tip. Either way this assertion flips, and the caller
  // is free to publish HELD over 186 blocks nobody read.
  let cov = newCoverage("c1", 1000);
  const tip = 1200;

  for (const r of plan(cov, tip, PROVIDERS, 3)) {
    cov = advance(cov, r, REQUIRED, REQUIRED);
  }

  const check = coverageCheck(cov, tip);
  assert.equal(check.covered, false, "a watcher 186 blocks behind must not report coverage");
  assert.equal(check.covered === false && check.verdict, "UNREADABLE");
  assert.notEqual(check.covered === false && check.verdict, "HELD");
  assert.equal(check.covered === false && check.reason, "coverage_gap");
  assert.equal(check.covered === false && check.gap, 186, "the gap is IN the verdict, not merely implied by it");
});

test("one provider answering is not coverage", () => {
  // The interval form of agreement.ts's `one_failed`. A range only alpha
  // answered for is a single-sourced read, and single-sourced reads are
  // UNREADABLE at a point; they cannot become coverage by being an interval.
  //
  // Killing mutation: in advance(), check `answeredBy.length > 0` instead of
  // requiring every label in `required`. The watermark then advances on one
  // provider's word and the log records two-source coverage that never happened.
  const cov = newCoverage("c1", 100);
  const after = advance(cov, { from: 100, to: 104 }, ["alpha"], REQUIRED);
  assert.equal(after.covered_through, 99, "coverage did not move");
  assert.equal(gap(after, 104), 5);
});

test("coverage cannot jump a hole, even on a fully answered range", () => {
  // The condition that is easiest to lose, because the range IS legitimately
  // answered by both providers -- it just is not the NEXT range. An out-of-order
  // retry, a resumed run or a hand-run backfill all produce this shape.
  //
  // Killing mutation: in advance(), drop the
  // `range.from !== cov.covered_through + 1` guard. covered_through then leaps
  // to 200 with blocks 100-149 never read, and every later verdict claims a
  // completeness it does not have. This is the mutation that produces a FALSE
  // HELD from entirely successful requests, which is why it is dangerous: no
  // error appears anywhere.
  const cov = newCoverage("c1", 100);
  const after = advance(cov, { from: 150, to: 200 }, REQUIRED, REQUIRED);
  assert.equal(after.covered_through, 99, "a prefix watermark may not summarise a non-prefix");
});

test("the ceiling is the smallest provider's, not the largest", () => {
  // Killing mutation: return Math.max in ceiling(). Plans then contain ranges
  // beta cannot serve, so beta fails on every one of them, so NOTHING ever
  // reaches two-source coverage -- and the watcher stalls at full request spend.
  assert.equal(ceiling(PROVIDERS), 5);
  const cov = newCoverage("c1", 1);
  const ranges = plan(cov, 12, PROVIDERS);
  assert.deepEqual(ranges, [{ from: 1, to: 5 }, { from: 6, to: 10 }, { from: 11, to: 12 }]);
});

test("a plan is contiguous, ascending, and stops at the tip", () => {
  // Killing mutation: emit `next + size` instead of `next + size - 1` as `to`.
  // Ranges then overlap by one block at every boundary -- which LOOKS harmless
  // (nothing is missed) and quietly double-counts a transfer sitting on a
  // boundary, turning one outbound transfer into two pieces of evidence.
  const cov = newCoverage("c1", 1);
  const ranges = plan(cov, 11, [{ label: "solo", maxRange: 4 }]);
  assert.deepEqual(ranges, [{ from: 1, to: 4 }, { from: 5, to: 8 }, { from: 9, to: 11 }]);
  for (let i = 1; i < ranges.length; i++) {
    assert.equal(ranges[i]!.from, ranges[i - 1]!.to + 1, "no gap and no overlap between consecutive ranges");
  }
  assert.equal(ranges.at(-1)!.to, 11, "the last range ends exactly at the tip");
});

test("nothing read yet is not block zero read", () => {
  // Killing mutation: initialise covered_through to 0 (or to from_block)
  // instead of from_block - 1. The first block of every commitment is then
  // skipped forever -- an off-by-one that is invisible in aggregate and is
  // exactly one block wide, which is all a transfer needs.
  const cov = newCoverage("c1", 5_000);
  assert.equal(cov.covered_through, 4_999);
  assert.equal(gap(cov, 5_000), 1, "block 5000 itself is still unread");
  const after = advance(cov, { from: 5_000, to: 5_000 }, REQUIRED, REQUIRED);
  assert.equal(after.covered_through, 5_000);
  assert.equal(coverageCheck(after, 5_000).covered, true);
});

test("full coverage clears the guard, and only full coverage", () => {
  // The must-not-fire direction. A guard that refuses everything is as useless
  // as one that refuses nothing, and it is the failure mode a nervous
  // implementation lands on -- so this asserts the check CAN say yes.
  //
  // Killing mutation: return `covered: false` unconditionally. The watcher then
  // never publishes a verdict at all and every commitment reads UNREADABLE
  // forever, which a casual reader mistakes for a chain problem.
  let cov = newCoverage("c1", 200);
  for (const r of plan(cov, 220, PROVIDERS)) cov = advance(cov, r, REQUIRED, REQUIRED);
  const check = coverageCheck(cov, 220);
  assert.equal(check.covered, true);
  assert.equal(check.covered === true && check.through, 220);
  assert.equal(gap(cov, 220), 0);
});

test("a growing gap at capacity is the chain outrunning the plan, and says so", () => {
  // Killing mutation: report `behind` on any positive gap rather than on gap
  // GROWTH. A watcher that is 40 blocks behind and closing then alarms
  // identically to one that is drifting, and an alarm that fires in the healthy
  // case is turned off by its operator within the week.
  const closing = fallingBehind(120, 80, 50);
  assert.equal(closing.behind, false, "a shrinking gap is not falling behind");

  const drifting = fallingBehind(80, 120, 50);
  assert.equal(drifting.behind, true);
  assert.equal(drifting.drift, 40);
  assert.equal(drifting.atCapacity, true, "it was already beyond what one cycle can close");

  const idle = fallingBehind(10, 30, 50);
  assert.equal(idle.behind, true);
  assert.equal(idle.atCapacity, false, "within capacity, so the next cycle should close it");
});

test("a provider ceiling below one block is refused rather than rounded up", () => {
  // Killing mutation: clamp maxRange to 1 instead of throwing. A typo'd 0 in
  // configuration then silently becomes the slowest possible watcher, and the
  // operator's mistake is absorbed instead of reported.
  assert.throws(() => ceiling([{ label: "bad", maxRange: 0 }]), /maxRange/);
  assert.throws(() => ceiling([{ label: "bad", maxRange: 2.5 }]), /maxRange/);
  assert.throws(() => ceiling([]), /ceiling over an empty set/);
});
