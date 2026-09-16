// What the watcher has actually READ, as opposed to what it has looked at. Issue #15.
//
// Every other file here decides what a reading MEANS. This one decides whether
// there was a reading at all, over the blocks the meaning depends on.
//
// The difference matters for exactly one class of predicate and it is the
// class this registry was built for. `balance-floor` is a point read: ask at a
// pinned height and the answer is complete by construction. `no-outbound-transfer`
// is not. It is a claim about an INTERVAL, and the only way to learn that
// nothing happened in an interval is to read every block in it. A transfer in
// an unread block is invisible in exactly the same way as a transfer that never
// existed -- and the verdict those two produce, if nobody is counting, is HELD.
//
// THE CONSTRAINT THAT SHAPES THIS FILE. `eth_getLogs` block ranges are capped
// per vendor, the free-tier ceilings are small and unequal (measured on Base:
// Alchemy 10 blocks, QuickNode ~5, dRPC times out past a few hundred), and Base
// produces a block every 2 seconds. So a watcher on free endpoints is
// structurally capable of falling behind, and "fell behind" must not render as
// "saw nothing wrong".
//
// THE RULE, and it is the whole file: A BLOCK IS COVERED ONLY WHEN EVERY
// REQUIRED PROVIDER HAS ANSWERED FOR IT. One provider's word is not coverage;
// it is agreement.ts's `one_failed` spread across an interval instead of a
// point, and it must reach the same verdict for the same reason.
//
// Nothing here talks to a network, and nothing here decides a verdict on its
// own. It produces the ranges to ask for, records what came back, and answers
// one question the evaluator cannot answer for itself: MAY THIS VERDICT BE
// TRUSTED AS COMPLETE?

import type { Verdict } from "./reading.ts";

/**
 * A provider's `eth_getLogs` range ceiling, in blocks.
 *
 * Configuration, not discovery, and deliberately so: the ceiling is a property
 * of the PLAN you are on, not of the chain. Probing for it means finding it by
 * being refused, which spends a request to learn something the vendor already
 * published, and re-learns it on every restart.
 */
export interface ProviderLimit {
  label: string;
  /** Maximum blocks per request, inclusive of both ends. Must be >= 1. */
  maxRange: number;
}

/**
 * How far a commitment has been read. One record per commitment, because
 * commitments have different start blocks and fall behind independently.
 *
 * `covered_through` is INCLUSIVE and means: every block in
 * [from_block, covered_through] has been read from every required provider.
 * Before anything is read it sits at `from_block - 1`, which is the only
 * honest encoding of "nothing yet" -- a zero would claim block 0 was read.
 */
export interface Coverage {
  commitment: string;
  from_block: number;
  covered_through: number;
}

/** A closed block interval. Both ends inclusive, matching `eth_getLogs`. */
export interface Range {
  from: number;
  to: number;
}

export function newCoverage(commitment: string, from_block: number): Coverage {
  return { commitment, from_block, covered_through: from_block - 1 };
}

/**
 * The effective ceiling: the SMALLEST across providers.
 *
 * Not the largest and not an average. A range only one provider can serve
 * cannot produce agreement, so asking for it buys a response that can never
 * become coverage. The slowest provider sets the pace of the whole watcher,
 * which is a real cost and belongs in the operator's face rather than hidden
 * behind a generous default.
 */
export function ceiling(providers: ProviderLimit[]): number {
  if (providers.length === 0) throw new Error("no providers: a ceiling over an empty set is not a ceiling");
  let min = Infinity;
  for (const p of providers) {
    if (!Number.isInteger(p.maxRange) || p.maxRange < 1) {
      throw new Error(`provider ${JSON.stringify(p.label)} has maxRange ${p.maxRange}; must be an integer >= 1`);
    }
    if (p.maxRange < min) min = p.maxRange;
  }
  return min;
}

/** Blocks known to be unread: from `covered_through` up to and including `tip`. */
export function gap(cov: Coverage, tip: number): number {
  return Math.max(0, tip - cov.covered_through);
}

/**
 * The ranges to request, in order, to close the gap to `tip`.
 *
 * Contiguous and ascending, starting at the first unread block. `maxRequests`
 * bounds one cycle's work: a watcher 100,000 blocks behind on a 10-block
 * ceiling must not emit 10,000 requests and block every other commitment, so it
 * takes a bite and reports the remainder. The REMAINDER IS THE POINT -- a
 * partial plan is why `coverageCheck` below can still refuse to say HELD.
 */
export function plan(
  cov: Coverage,
  tip: number,
  providers: ProviderLimit[],
  maxRequests = Infinity,
): Range[] {
  const size = ceiling(providers);
  const ranges: Range[] = [];
  let next = cov.covered_through + 1;
  while (next <= tip && ranges.length < maxRequests) {
    const to = Math.min(next + size - 1, tip);
    ranges.push({ from: next, to });
    next = to + 1;
  }
  return ranges;
}

/**
 * Record that `range` was answered, and advance coverage only if it may be.
 *
 * TWO CONDITIONS, AND THE SECOND IS THE ONE THAT IS EASY TO LOSE.
 *
 *   1. Every required provider answered for this exact range. A range answered
 *      by one provider is not coverage.
 *   2. The range STARTS where coverage ended. Answers can arrive for any range
 *      a caller asks for, including one past a hole -- an out-of-order retry, a
 *      resumed run, a hand-run backfill. Advancing to `range.to` on any
 *      successful answer would jump the watermark over blocks nobody read, and
 *      the resulting log says HELD over a break it never looked at. Coverage is
 *      a PREFIX, and only a prefix can be summarised by a single number.
 *
 * Returns the record unchanged when either condition fails. Unchanged is the
 * safe direction: it costs a re-read, and the other direction costs a false HELD.
 */
export function advance(
  cov: Coverage,
  range: Range,
  answeredBy: readonly string[],
  required: readonly string[],
): Coverage {
  if (range.to < range.from) return cov;
  const answered = new Set(answeredBy);
  for (const label of required) {
    if (!answered.has(label)) return cov; // condition 1
  }
  if (range.from !== cov.covered_through + 1) return cov; // condition 2
  return { ...cov, covered_through: range.to };
}

export interface CoverageOk {
  covered: true;
  through: number;
}

export interface CoverageShort {
  covered: false;
  verdict: Extract<Verdict, "UNREADABLE">;
  /** Machine-readable, like every other reason in this project. */
  reason: "coverage_gap";
  gap: number;
  covered_through: number;
  tip: number;
}

export type CoverageCheck = CoverageOk | CoverageShort;

/**
 * May a verdict about `tip` be published?
 *
 * This is the guard the issue asks for, and the reason it returns a verdict
 * rather than a boolean: the answer to "you have not read far enough" is not
 * "wait quietly", it is UNREADABLE WITH THE GAP IN IT. A watcher that is behind
 * and silent is indistinguishable from a watcher that is current and seeing
 * nothing, which is the one confusion this project exists to end.
 *
 * Note the verdict returned is never HELD and never BROKEN. This function
 * cannot clear a commitment; it can only refuse to let one be cleared. A BROKEN
 * found inside the blocks that WERE read stands on its own -- a break you have
 * seen does not become unseen because you have not finished looking.
 */
export function coverageCheck(cov: Coverage, tip: number): CoverageCheck {
  const g = gap(cov, tip);
  if (g === 0) return { covered: true, through: cov.covered_through };
  return {
    covered: false,
    verdict: "UNREADABLE",
    reason: "coverage_gap",
    gap: g,
    covered_through: cov.covered_through,
    tip,
  };
}

/**
 * Is the watcher losing ground?
 *
 * A gap alone does not say that: a watcher 40 blocks behind and closing is
 * healthy, and one 40 blocks behind and drifting is broken, and they print the
 * same number. Feed this the previous cycle's gap and the current one.
 *
 * `blocksPerCycle` is what the cycle could actually close (`maxRequests * ceiling`).
 * FALLING BEHIND IS NOT "the gap grew" -- on a live chain the tip moves during
 * every cycle, so a gap that grows while the watcher reads at capacity is the
 * chain outrunning the plan, which is worth saying in exactly those words.
 */
export function fallingBehind(
  previousGap: number,
  currentGap: number,
  blocksPerCycle: number,
): { behind: boolean; drift: number; atCapacity: boolean } {
  const drift = currentGap - previousGap;
  return {
    behind: drift > 0,
    drift,
    atCapacity: previousGap >= blocksPerCycle,
  };
}
