// Coverage tracking and cadence planning for interval predicates (Issue #15).
//
// Balance-floor asks at a pinned block height and its answer is complete by
// construction. no-outbound-transfer, only-to, and no-new-mint are claims
// about every block in a window: a transfer in an unread block is
// indistinguishable from a transfer that never happened.
//
// Unless a watcher counts and verifies unread blocks, an unread break renders
// as HELD — the exact substitution agreement.ts refuses at a single point,
// arriving over an interval instead.
//
// The invariants enforced here:
// 1. PREFIX WATERMARK: A covered block height is an inclusive contiguous prefix.
//    "Nothing read yet" must never encode as block 0 having been read.
// 2. ADVANCE ON AGREEMENT ONLY: A range advances the watermark only when EVERY
//    required provider answered and agreed for that range. A range only one
//    provider answered for can never advance coverage.
// 3. CONTIGUITY (NO JUMPING HOLES): Coverage advances only if the range begins
//    immediately adjacent to where coverage currently ends (fromBlock === current + 1).
//    Out-of-order responses or disjoint ranges cannot jump the watermark.
// 4. CEILING IS MINIMUM: Effective range ceiling is the strictest provider ceiling,
//    because a request cannot exceed the capacity of its most constrained endpoint.
// 5. UNREADABLE ON GAPS: When the gap cannot be closed, publish UNREADABLE with
//    the gap in it. A watcher falling behind must never look like a watcher seeing
//    nothing wrong.

export interface BlockRange {
  from: number;
  to: number;
}

/**
 * Pluggable store tracking the highest contiguous block read and agreed
 * from both providers, keyed per commitment id.
 */
export interface CoverageStore {
  getCovered: (commitmentId: string) => Promise<number | undefined> | number | undefined;
  setCovered: (commitmentId: string, height: number) => Promise<void> | void;
}

/**
 * Standard in-memory coverage store for test harnesses and single-process watchers.
 */
export class MemoryCoverageStore implements CoverageStore {
  private covered = new Map<string, number>();

  constructor(initial?: Record<string, number> | Map<string, number>) {
    if (initial instanceof Map) {
      this.covered = new Map(initial);
    } else if (initial) {
      this.covered = new Map(Object.entries(initial));
    }
  }

  getCovered(commitmentId: string): number | undefined {
    return this.covered.get(commitmentId);
  }

  setCovered(commitmentId: string, height: number): void {
    this.covered.set(commitmentId, height);
  }

  entries(): [string, number][] {
    return Array.from(this.covered.entries());
  }

  clear(): void {
    this.covered.clear();
  }
}

/**
 * Split an interval [fromBlock, toBlock] into contiguous sub-ranges
 * each of size at most maxRange blocks.
 */
export function planPages(fromBlock: number, toBlock: number, maxRange: number): BlockRange[] {
  if (fromBlock > toBlock) return [];
  if (maxRange <= 0) throw new Error(`maxRange must be positive integer, got ${maxRange}`);
  const pages: BlockRange[] = [];
  let cur = fromBlock;
  while (cur <= toBlock) {
    const next = Math.min(cur + maxRange - 1, toBlock);
    pages.push({ from: cur, to: next });
    cur = next + 1;
  }
  return pages;
}

/**
 * Determine the effective range ceiling across configured providers.
 * Strictest (minimum) ceiling wins, because a range only one provider
 * can serve cannot become agreed two-source coverage.
 */
export function effectiveRangeCeiling(
  config?: Record<string, number> | { maxRange?: number }[] | { label: string; maxRange?: number }[],
  fallback: number = 10,
): number {
  if (!config) return fallback;
  let values: number[] = [];
  if (Array.isArray(config)) {
    if (config.length === 0) return fallback;
    for (const p of config) {
      if (p.maxRange !== undefined) {
        if (typeof p.maxRange !== "number" || p.maxRange <= 0 || !Number.isInteger(p.maxRange)) {
          throw new Error(`maxRange must be a positive integer, got ${p.maxRange}`);
        }
        values.push(p.maxRange);
      }
    }
  } else {
    const entries = Object.entries(config);
    if (entries.length === 0) return fallback;
    for (const [key, val] of entries) {
      if (typeof val !== "number" || val <= 0 || !Number.isInteger(val)) {
        throw new Error(`maxRange for ${key} must be a positive integer, got ${val}`);
      }
      values.push(val);
    }
  }
  if (values.length === 0) return fallback;
  return Math.min(...values);
}

/**
 * Detect whether a watcher is falling behind (the gap is growing faster than it closes).
 * Differentiates a closing gap from a drifting gap.
 */
export function fallingBehind(
  prevGap: number,
  curGap: number,
  capacity: number,
): { behind: boolean; drift: number; atCapacity: boolean } {
  const drift = curGap - prevGap;
  const behind = drift > 0;
  const atCapacity = prevGap > capacity;
  return { behind, drift, atCapacity };
}

/**
 * Pure coverage advancement step.
 * Returns the new watermark and whether it advanced.
 * Refuses to advance if:
 *  - Both providers did not answer and agree for the range (agreed is false).
 *  - The range does not begin immediately after currentCovered (contiguous prefix rule).
 */
export function advanceCoverage(
  currentCovered: number,
  range: BlockRange,
  agreed: boolean,
): { covered: number; advanced: boolean } {
  if (!agreed) {
    return { covered: currentCovered, advanced: false };
  }
  // Contiguity check: range must begin immediately after currentCovered
  if (range.from !== currentCovered + 1) {
    return { covered: currentCovered, advanced: false };
  }
  return { covered: range.to, advanced: true };
}
