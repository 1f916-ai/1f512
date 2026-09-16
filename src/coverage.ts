// The coverage record: the highest block whose logs have been read from BOTH
// providers. Issue #15.
//
// The constraint this file exists for: eth_getLogs block ranges are capped per
// vendor, and the free-tier ceilings are small and wildly unequal -- measured
// on Base mainnet, Alchemy answers a 10-block range and refuses a 2000-block
// one, QuickNode answers about 5. Base produces a block every 2 seconds, so a
// 10-block window is 20 seconds of chain. A watcher that reads one window per
// cycle is not watching the chain; it is watching a slice of it, and the
// blocks in between are simply not seen. Missing a transfer in those unseen
// blocks means publishing HELD over a break.
//
// So the rule: a watcher may report a verdict about the tip only if it has
// actually read every block from the last covered height to the tip, from BOTH
// providers. This file is the part that has to be right.
//
// Deliberately NOT here: any I/O, any scheduling, any notion of which provider
// is "better". The record is pure: give it the windows you read and the
// answers you got, and it tells you how far you are caught up and where the
// gap is. The caller decides what to do with that.

import type { Attempt } from "./agreement.ts";

/** One block range, inclusive on both ends. */
export interface Window {
  from: number;
  to: number;
}

/**
 * One window's read result, as the coverage record sees it.
 *
 * `covered` is true iff both providers answered this window AND their answers
 * agree. A range only one answered for is never covered, and a range the two
 * providers disagree about is never covered: in both cases a stranger could not
 * recompute the window, so it does not count.
 */
export interface WindowResult {
  window: Window;
  covered: boolean;
  /** Every attempt, kept verbatim, for the record. */
  attempts: Attempt[];
}

/**
 * The verdict a coverage gap forces, for callers that want it stated rather
 * than implied. There is exactly one: a gap never produces HELD or BROKEN. It
 * produces UNREADABLE.
 */
export const GAP_VERDICT = "UNREADABLE" as const;

/**
 * The range ceiling is a property of the PLAN, not the chain. It is the
 * largest block range a single eth_getLogs call may cover and still be
 * answered. It differs per provider and per tier, and it is measured, not read
 * off documentation. The watcher takes it as configuration.
 *
 * The watcher reads every window from BOTH providers, so a window is only as
 * wide as the NARROWEST provider's ceiling. A window wider than that is
 * answered by one provider and refused by the other, and a range only one
 * answered for is never covered.
 */
export function planCeiling(ceilings: Record<string, number>): number {
  const values = Object.values(ceilings);
  if (values.length === 0) {
    throw new Error("planCeiling needs at least one provider ceiling");
  }
  const min = Math.min(...values);
  if (!Number.isSafeInteger(min) || min <= 0) {
    throw new Error(`planCeiling must be a positive safe integer, got ${min}`);
  }
  return min;
}

/**
 * The windows needed to cover every block from (covered+1) to tip, inclusive,
 * each at most `ceiling` blocks wide.
 *
 * Returns [] when there is nothing to cover (tip <= covered). That is the
 * "already caught up" case: a verdict about the tip is legitimate without
 * reading anything new.
 */
export function windowsToCover(covered: number, tip: number, ceiling: number): Window[] {
  if (!Number.isSafeInteger(covered) || !Number.isSafeInteger(tip)) {
    throw new Error(`covered and tip must be safe integers, got covered=${covered} tip=${tip}`);
  }
  if (ceiling <= 0) throw new Error(`ceiling must be positive, got ${ceiling}`);
  if (tip <= covered) return [];
  const windows: Window[] = [];
  let from = covered + 1;
  while (from <= tip) {
    const to = Math.min(from + ceiling - 1, tip);
    windows.push({ from, to });
    from = to + 1;
  }
  return windows;
}

export interface CoverageDecision {
  /** The new covered height after this round. Never advances past a gap. */
  covered: number;
  /** True iff every block up to `tip` is now covered. */
  caughtUp: boolean;
  /** The first uncovered block, if any. */
  gapFrom?: number;
  /** The number of uncovered blocks, if any. */
  gapSize?: number;
  /** The tip, for the record. */
  tip: number;
}

/**
 * Decide what a round of windowed reads means for the coverage record.
 *
 * The rule: advance `covered` only as far as the highest block whose logs have
 * been read from BOTH providers. A block is covered iff some window result that
 * includes it is marked covered. The advance walks forward from (covered+1) and
 * stops at the first uncovered block: coverage is contiguous, and a hole in the
 * middle is a gap as much as a hole at the end.
 *
 * This is the guard the test in test/coverage.test.ts exists to kill. Delete
 * the walk (make it always return caughtUp: true) and the "must not return
 * HELD over a gap" test goes red.
 */
export function advanceCoverage(
  covered: number,
  tip: number,
  results: WindowResult[],
): CoverageDecision {
  // Build the set of blocks that are actually covered: a block is covered iff
  // some window result that includes it is marked covered (both providers
  // answered and agreed).
  const coveredBlocks = new Set<number>();
  for (const r of results) {
    if (!r.covered) continue;
    for (let b = r.window.from; b <= r.window.to; b++) coveredBlocks.add(b);
  }

  let newCovered = covered;
  let gapFrom: number | undefined;
  let next = covered + 1;
  while (next <= tip) {
    if (!coveredBlocks.has(next)) {
      gapFrom = next;
      break;
    }
    newCovered = next;
    next++;
  }

  const caughtUp = newCovered >= tip;
  return {
    covered: newCovered,
    caughtUp,
    gapFrom,
    gapSize: gapFrom === undefined ? 0 : tip - gapFrom + 1,
    tip,
  };
}
