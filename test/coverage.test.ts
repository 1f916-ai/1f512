// Pure invariants for block coverage tracking (Issue #15).
//
// A covered block height is a prefix watermark, inclusive, starting at
// from_block - 1. A single number can only summarise a contiguous prefix:
// jumping over unread blocks produces a false HELD assembled entirely from
// successful requests, with no error raised anywhere.

import test from "node:test";
import assert from "node:assert/strict";
import {
  planPages,
  effectiveRangeCeiling,
  advanceCoverage,
  fallingBehind,
  MemoryCoverageStore,
} from "../src/coverage.ts";

test("planPages splits intervals into contiguous bounded slices", () => {
  assert.deepEqual(planPages(101, 125, 10), [
    { from: 101, to: 110 },
    { from: 111, to: 120 },
    { from: 121, to: 125 },
  ]);

  assert.deepEqual(planPages(100, 100, 10), [{ from: 100, to: 100 }]);
  assert.deepEqual(planPages(105, 100, 10), []);
  assert.throws(() => planPages(1, 10, 0), /maxRange must be positive/);
});

test("effectiveRangeCeiling takes the STRICTEST ceiling across providers", () => {
  // Killing mutation: use Math.max instead of Math.min.
  // Alchemy 10, QuickNode 5:
  assert.equal(effectiveRangeCeiling({ alchemy: 10, quicknode: 5 }), 5);

  // Array of provider objects
  assert.equal(
    effectiveRangeCeiling([
      { label: "alpha", maxRange: 100 },
      { label: "beta", maxRange: 10 },
    ]),
    10,
  );

  // Fallback when unconfigured
  assert.equal(effectiveRangeCeiling(undefined, 20), 20);
  assert.equal(effectiveRangeCeiling({}, 15), 15);
  assert.equal(effectiveRangeCeiling([], 12), 12);

  // Killing mutation: clamp maxRange to 1 instead of throwing.
  // A typo'd 0 or negative number in configuration must be refused immediately.
  assert.throws(() => effectiveRangeCeiling({ bad: 0 }), /maxRange for bad must be a positive integer/);
  assert.throws(() => effectiveRangeCeiling({ bad: -5 }), /maxRange for bad must be a positive integer/);
  assert.throws(() => effectiveRangeCeiling({ bad: 2.5 }), /maxRange for bad must be a positive integer/);
  assert.throws(() => effectiveRangeCeiling([{ maxRange: 0 }]), /maxRange must be a positive integer/);
});

test("fallingBehind distinguishes gap growth from healthy gap reduction", () => {
  // Killing mutation: report behind on any positive gap rather than on gap growth.
  // A watcher that is 120 blocks behind and closing to 80 is healthy, not falling behind.
  const closing = fallingBehind(120, 80, 50);
  assert.equal(closing.behind, false, "a shrinking gap is not falling behind");
  assert.equal(closing.drift, -40);

  // Drifting gap beyond capacity:
  const drifting = fallingBehind(80, 120, 50);
  assert.equal(drifting.behind, true, "gap growth must alarm");
  assert.equal(drifting.drift, 40);
  assert.equal(drifting.atCapacity, true, "it was already beyond what one cycle can close");

  // Drifting gap within capacity:
  const idle = fallingBehind(10, 30, 50);
  assert.equal(idle.behind, true);
  assert.equal(idle.drift, 20);
  assert.equal(idle.atCapacity, false, "within capacity, but drifting");
});

test("advanceCoverage advances ONLY when both providers agreed", () => {
  // Killing mutation: advance whether agreed is true or false.
  const unagreed = advanceCoverage(100, { from: 101, to: 110 }, false);
  assert.equal(unagreed.advanced, false);
  assert.equal(unagreed.covered, 100, "unagreed range cannot advance watermark");

  const agreed = advanceCoverage(100, { from: 101, to: 110 }, true);
  assert.equal(agreed.advanced, true);
  assert.equal(agreed.covered, 110);
});

test("advanceCoverage refuses to jump holes (contiguity guard)", () => {
  // Killing mutation: drop the contiguity guard (range.from !== currentCovered + 1).
  // A disjoint range (e.g. 105..115 when covered is 100) would jump over blocks 101..104.
  const jump = advanceCoverage(100, { from: 105, to: 115 }, true);
  assert.equal(jump.advanced, false, "cannot jump over unread blocks");
  assert.equal(jump.covered, 100, "watermark stays at prefix boundary");
});

test("MemoryCoverageStore isolates coverage per commitment id", () => {
  const store = new MemoryCoverageStore({ "c-1": 100 });
  assert.equal(store.getCovered("c-1"), 100);
  assert.equal(store.getCovered("c-2"), undefined);

  store.setCovered("c-2", 250);
  assert.equal(store.getCovered("c-1"), 100);
  assert.equal(store.getCovered("c-2"), 250);
});
