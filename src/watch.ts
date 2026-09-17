// One cycle: read the chain, decide, append. This is the whole system joined up.
//
// Everything hard has already been decided elsewhere, and this file is
// deliberately the place where nothing new is decided:
//
//   rpc.ts        asks two providers, pinned to one block, and never leaks a key
//   agreement.ts  says whether two answers count as one, or UNREADABLE
//   evaluate.ts   turns a chain state into a verdict at time T
//   log.ts        appends, refusing to grow a broken chain
//   coverage.ts   tracks contiguous agreed block heights per commitment
//
// The rules this file adds:
// 1. A CYCLE ALWAYS WRITES A LINE. Not only when the news is good, not only when
//    something changed. If the providers were unreachable, the log says UNREADABLE
//    at that instant, with the errors. A gap in the log means "nobody looked",
//    and a reader cannot tell that from "we looked and could not see" unless the
//    second case leaves a record.
// 2. WATCHER CADENCE & COVERAGE INVARIANT (Issue #15):
//    - Track, per commitment, the highest block whose logs have actually been
//      read from both providers. Never advance it past a range only one answered for.
//    - Cover every block between the last covered height and the tip across paged
//      requests before reporting anything about the tip.
//    - When it cannot keep up (the gap is growing faster than it closes or exceeds
//      cadence budget), publish an UNREADABLE line naming the gap. A watcher
//      falling behind must not look like a watcher seeing nothing wrong.
//    - Range ceilings are configured per provider, because ceilings are a
//      property of the plan, not the chain.
//    - AN UNCOVERED BLOCK RANGE CANNOT RETURN HELD.

import { agree, type Attempt } from "./agreement.ts";
import type { ChainState, Commitment } from "./commitment.ts";
import {
  type BlockRange,
  type CoverageStore,
  MemoryCoverageStore,
  planPages,
  effectiveRangeCeiling,
  advanceCoverage,
  fallingBehind,
} from "./coverage.ts";
import { evaluate } from "./evaluate.ts";
import { append, type Appender } from "./log.ts";
import type { Reading, RpcExchange } from "./reading.ts";

export {
  type BlockRange,
  type CoverageStore,
  MemoryCoverageStore,
  planPages,
  effectiveRangeCeiling,
  advanceCoverage,
  fallingBehind,
};

export interface CycleDeps {
  /**
   * Ask the chain for everything this commitment needs, at a pinned height,
   * from two different providers. Range can be supplied when paged block coverage is active.
   */
  read: (c: Commitment, at_block: number, range?: BlockRange) => Promise<{ method: string; params: unknown[]; attempts: Attempt[] }>;
  /** Turn an agreed RPC result into the state the evaluator reads. */
  decode: (result: unknown, at_block: number, at_time: number) => ChainState;
  /** The height to pin this cycle to. Chosen by the caller, usually a finalized head. */
  block: () => Promise<number>;
  /** T. Supplied, never read from the clock inside the pure code. */
  now: () => number;
  logPath: string;
  write?: Appender;

  // Cadence & Coverage Tracking additions (Issue #15)
  /** Per-commitment covered block height store. */
  coverage?: CoverageStore;
  /** Ceiling on the number of blocks per request, per provider label. */
  providerCeilings?: Record<string, number>;
  /** Explicit maximum range in blocks per request if not derived from providerCeilings. */
  maxRange?: number;
  /**
   * Maximum allowed block gap between last covered height and tip.
   * If gap > maxGap (or cannot keep up), publishes UNREADABLE with the gap.
   */
  maxGap?: number;
  /**
   * Maximum paged requests to execute in one cycle before declaring the watcher cannot keep up.
   */
  maxPagesPerCycle?: number;
  /**
   * Initial block height if no prior coverage is recorded for this commitment.
   */
  initialBlock?: number | ((c: Commitment, tip: number) => Promise<number> | number);
  /**
   * Optional custom combiner for results from multiple paged requests.
   */
  combineResults?: (results: unknown[]) => unknown;
}

export interface CycleResult {
  commitment: string;
  line: Reading;
}

/**
 * Run one commitment through one cycle and append exactly one line.
 *
 * Never throws for chain reasons -- an unreachable provider is a verdict, not
 * an exception. It DOES throw if the log itself cannot be appended to, because
 * that is not something to paper over: a cycle that cannot write has not
 * happened, and pretending otherwise puts the registry in a state where it
 * believes it is watching and is not.
 */
export async function cycle(c: Commitment, deps: CycleDeps): Promise<CycleResult> {
  const at_time = deps.now();
  let tip: number;

  try {
    tip = await deps.block();
  } catch (e) {
    // Could not even establish a height or reach the providers. That is still a
    // reading, and it still gets written down.
    const line = await append(
      deps.logPath,
      {
        commitment: c.id,
        verdict: "UNREADABLE",
        reason: "could not read the chain",
        rpc: [],
        read_at: at_time,
        note: String(e).slice(0, 200),
      },
      deps.write,
    );
    return { commitment: c.id, line };
  }

  // If coverage tracking is not configured, execute single unconstrained cycle (backward-compatible)
  if (!deps.coverage) {
    let method = "unknown";
    let params: unknown[] = [];
    let attempts: Attempt[] = [];

    try {
      const read = await deps.read(c, tip);
      method = read.method;
      params = read.params;
      attempts = read.attempts;
    } catch (e) {
      const line = await append(
        deps.logPath,
        {
          commitment: c.id,
          verdict: "UNREADABLE",
          reason: "could not read the chain",
          rpc: [],
          read_at: at_time,
          note: String(e).slice(0, 200),
        },
        deps.write,
      );
      return { commitment: c.id, line };
    }

    const a = agree(attempts);
    const exchanges: RpcExchange[] = attempts
      .filter((x): x is Extract<Attempt, { ok: true }> => x.ok)
      .map((x) => ({ provider: x.provider, method, params, result: x.result, at_block: x.at_block }));

    if (!a.agreed) {
      const line = await append(
        deps.logPath,
        {
          commitment: c.id,
          verdict: "UNREADABLE",
          reason: a.reason,
          rpc: exchanges,
          read_at: at_time,
          note: describeFailures(attempts),
        },
        deps.write,
      );
      return { commitment: c.id, line };
    }

    const state = deps.decode(a.result, a.at_block!, at_time);
    const ev = evaluate(c, state, at_time);
    const line = await append(
      deps.logPath,
      {
        commitment: c.id,
        verdict: ev.verdict,
        reason: ev.reason,
        rpc: exchanges,
        read_at: at_time,
        ...(ev.evidence ? { note: JSON.stringify(ev.evidence).slice(0, 500) } : {}),
      },
      deps.write,
    );
    return { commitment: c.id, line };
  }

  // Coverage tracking is active
  const coverage = deps.coverage;
  const storedCovered = await coverage.getCovered(c.id);
  const isInitial = storedCovered === undefined;

  let lastCovered: number;
  if (storedCovered !== undefined) {
    lastCovered = storedCovered;
  } else if (deps.initialBlock !== undefined) {
    const initB = typeof deps.initialBlock === "function" ? await deps.initialBlock(c, tip) : deps.initialBlock;
    // Inclusive prefix watermark starts at initB - 1 so initB itself is included in planned pages
    lastCovered = initB - 1;
  } else {
    // First observation with no prior coverage starts at tip: watermark is tip - 1 so tip itself is verified
    lastCovered = tip - 1;
  }

  const ceiling = deps.maxRange ?? effectiveRangeCeiling(deps.providerCeilings, 10);
  const gap = tip - lastCovered;

  // When it cannot keep up: gap exceeds configured maxGap
  if (deps.maxGap !== undefined && gap > deps.maxGap) {
    const line = await append(
      deps.logPath,
      {
        commitment: c.id,
        verdict: "UNREADABLE",
        reason: "gap_uncovered",
        rpc: [],
        read_at: at_time,
        note: `watcher falling behind: gap of ${gap} blocks (covered ${isInitial ? "none" : lastCovered}, tip ${tip}) exceeds maxGap of ${deps.maxGap}`,
      },
      deps.write,
    );
    return { commitment: c.id, line };
  }

  const pages = gap > 0 ? planPages(lastCovered + 1, tip, ceiling) : [];

  // When it cannot keep up: pages needed exceed cycle limit
  if (deps.maxPagesPerCycle !== undefined && pages.length > deps.maxPagesPerCycle) {
    const line = await append(
      deps.logPath,
      {
        commitment: c.id,
        verdict: "UNREADABLE",
        reason: "gap_uncovered",
        rpc: [],
        read_at: at_time,
        note: `watcher falling behind: gap of ${gap} blocks (${pages.length} pages needed, max ${deps.maxPagesPerCycle} allowed per cycle)`,
      },
      deps.write,
    );
    return { commitment: c.id, line };
  }

  // If no new blocks have elapsed since last covered, run observation at tip
  if (pages.length === 0) {
    let read;
    try {
      read = await deps.read(c, tip, { from: tip, to: tip });
    } catch (e) {
      const line = await append(
        deps.logPath,
        {
          commitment: c.id,
          verdict: "UNREADABLE",
          reason: "could not read the chain",
          rpc: [],
          read_at: at_time,
          note: String(e).slice(0, 200),
        },
        deps.write,
      );
      return { commitment: c.id, line };
    }

    const a = agree(read.attempts);
    const exchanges: RpcExchange[] = read.attempts
      .filter((x): x is Extract<Attempt, { ok: true }> => x.ok)
      .map((x) => ({ provider: x.provider, method: read.method, params: read.params, result: x.result, at_block: x.at_block }));

    if (!a.agreed) {
      const line = await append(
        deps.logPath,
        {
          commitment: c.id,
          verdict: "UNREADABLE",
          reason: a.reason,
          rpc: exchanges,
          read_at: at_time,
          note: describeFailures(read.attempts),
        },
        deps.write,
      );
      return { commitment: c.id, line };
    }

    const state = deps.decode(a.result, a.at_block!, at_time);
    const ev = evaluate(c, state, at_time);
    const line = await append(
      deps.logPath,
      {
        commitment: c.id,
        verdict: ev.verdict,
        reason: ev.reason,
        rpc: exchanges,
        read_at: at_time,
        ...(ev.evidence ? { note: JSON.stringify(ev.evidence).slice(0, 500) } : {}),
      },
      deps.write,
    );
    return { commitment: c.id, line };
  }

  const combine = (results: unknown[]): unknown => {
    if (deps.combineResults) return deps.combineResults(results);
    if (results.every(Array.isArray)) return results.flat();
    if (results.length === 1) return results[0];
    const allTransfers = results.flatMap((r: any) => (Array.isArray(r?.transfers) ? r.transfers : []));
    const allBalances = Object.assign({}, ...results.map((r: any) => r?.balances ?? {}));
    return { transfers: allTransfers, balances: allBalances };
  };

  // Page across every block between lastCovered + 1 and tip
  let currentCovered = lastCovered;
  const allExchanges: RpcExchange[] = [];
  const pageResults: unknown[] = [];

  for (const page of pages) {
    let read;
    try {
      read = await deps.read(c, tip, page);
    } catch (e) {
      // Unreachable or error during page read:
      if (currentCovered > lastCovered) {
        await coverage.setCovered(c.id, currentCovered);
      }

      // If earlier pages in this cycle already witnessed a break, BROKEN stands:
      // a break you have seen does not become unseen because you have not finished looking.
      if (pageResults.length > 0) {
        const partialState = deps.decode(combine(pageResults), currentCovered, at_time);
        const ev = evaluate(c, partialState, at_time);
        if (ev.verdict === "BROKEN") {
          const line = await append(
            deps.logPath,
            {
              commitment: c.id,
              verdict: "BROKEN",
              reason: ev.reason,
              rpc: allExchanges,
              read_at: at_time,
              ...(ev.evidence ? { note: JSON.stringify(ev.evidence).slice(0, 500) } : {}),
            },
            deps.write,
          );
          return { commitment: c.id, line };
        }
      }

      const line = await append(
        deps.logPath,
        {
          commitment: c.id,
          verdict: "UNREADABLE",
          reason: "could not read the chain",
          rpc: allExchanges,
          read_at: at_time,
          note: `uncovered gap: blocks ${page.from}..${tip} (covered up to ${isInitial && currentCovered === lastCovered ? "none" : currentCovered}): ${String(e).slice(0, 200)}`,
        },
        deps.write,
      );
      return { commitment: c.id, line };
    }

    const a = agree(read.attempts);
    const pageExchanges: RpcExchange[] = read.attempts
      .filter((x): x is Extract<Attempt, { ok: true }> => x.ok)
      .map((x) => ({ provider: x.provider, method: read.method, params: read.params, result: x.result, at_block: x.at_block }));
    allExchanges.push(...pageExchanges);

    const step = advanceCoverage(currentCovered, page, a.agreed);
    if (!step.advanced) {
      // NEVER advance past a range only one answered for!
      if (currentCovered > lastCovered) {
        await coverage.setCovered(c.id, currentCovered);
      }

      // Check if confirmed pages read so far already witnessed a break:
      if (pageResults.length > 0) {
        const partialState = deps.decode(combine(pageResults), currentCovered, at_time);
        const ev = evaluate(c, partialState, at_time);
        if (ev.verdict === "BROKEN") {
          const line = await append(
            deps.logPath,
            {
              commitment: c.id,
              verdict: "BROKEN",
              reason: ev.reason,
              rpc: allExchanges,
              read_at: at_time,
              ...(ev.evidence ? { note: JSON.stringify(ev.evidence).slice(0, 500) } : {}),
            },
            deps.write,
          );
          return { commitment: c.id, line };
        }
      }

      const line = await append(
        deps.logPath,
        {
          commitment: c.id,
          verdict: "UNREADABLE",
          reason: a.reason,
          rpc: allExchanges,
          read_at: at_time,
          note: `uncovered gap: blocks ${page.from}..${tip} (covered up to ${isInitial && currentCovered === lastCovered ? "none" : currentCovered}); ${describeFailures(read.attempts)}`.slice(0, 500),
        },
        deps.write,
      );
      return { commitment: c.id, line };
    }

    // Both answered and agreed for this page: advance covered height
    currentCovered = step.covered;
    await coverage.setCovered(c.id, currentCovered);
    pageResults.push(a.result);
  }

  // Every block up to tip was successfully read and agreed
  const combined = combine(pageResults);
  const state = deps.decode(combined, tip, at_time);
  const ev = evaluate(c, state, at_time);
  const line = await append(
    deps.logPath,
    {
      commitment: c.id,
      verdict: ev.verdict,
      reason: ev.reason,
      rpc: allExchanges,
      read_at: at_time,
      ...(ev.evidence ? { note: JSON.stringify(ev.evidence).slice(0, 500) } : {}),
    },
    deps.write,
  );
  return { commitment: c.id, line };
}

function describeFailures(attempts: Attempt[]): string {
  const failed = attempts.filter((a): a is Extract<Attempt, { ok: false }> => !a.ok);
  if (failed.length === 0) return "providers answered but did not agree";
  return failed.map((f) => `${f.provider}: ${f.error}`).join("; ").slice(0, 500);
}

/**
 * Run every commitment once. One failing commitment must not stop the others:
 * a registry that stops watching everything because one entry is malformed has
 * turned a small problem into a blackout.
 */
export async function cycleAll(
  commitments: Commitment[],
  deps: CycleDeps,
): Promise<{ done: CycleResult[]; failed: { commitment: string; error: string }[] }> {
  const done: CycleResult[] = [];
  const failed: { commitment: string; error: string }[] = [];
  for (const c of commitments) {
    try {
      done.push(await cycle(c, deps));
    } catch (e) {
      failed.push({ commitment: c.id, error: String(e).slice(0, 200) });
    }
  }
  return { done, failed };
}
