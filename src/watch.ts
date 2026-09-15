// One cycle: read the chain, decide, append. This is the whole system joined up.
//
// Everything hard has already been decided elsewhere, and this file is
// deliberately the place where nothing new is decided:
//
//   rpc.ts        asks two providers, pinned to one block, and never leaks a key
//   agreement.ts  says whether two answers count as one, or UNREADABLE
//   evaluate.ts   turns a chain state into a verdict at time T
//   log.ts        appends, refusing to grow a broken chain
//
// The one rule this file adds: A CYCLE ALWAYS WRITES A LINE. Not only when the
// news is good, not only when something changed. If the providers were
// unreachable, the log says UNREADABLE at that instant, with the errors. A gap
// in the log means "nobody looked", and a reader cannot tell that from "we
// looked and could not see" unless the second case leaves a record.
//
// That is the same principle as the verdict set itself: silence is never
// allowed to read as reassurance.

import { agree, type Attempt } from "./agreement.ts";
import type { ChainState, Commitment } from "./commitment.ts";
import { evaluate } from "./evaluate.ts";
import { append, type Appender } from "./log.ts";
import type { Reading, RpcExchange } from "./reading.ts";

export interface CycleDeps {
  /**
   * Ask the chain for everything this commitment needs, at a pinned height,
   * from two different providers. Injected rather than imported so a caller can
   * supply a fixture, a fork, or a different chain entirely.
   */
  read: (c: Commitment, at_block: number) => Promise<{ method: string; params: unknown[]; attempts: Attempt[] }>;
  /** Turn an agreed RPC result into the state the evaluator reads. */
  decode: (result: unknown, at_block: number, at_time: number) => ChainState;
  /** The height to pin this cycle to. Chosen by the caller, usually a finalized head. */
  block: () => Promise<number>;
  /** T. Supplied, never read from the clock inside the pure code. */
  now: () => number;
  logPath: string;
  write?: Appender;
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
  let at_block: number;
  let method = "unknown";
  let params: unknown[] = [];
  let attempts: Attempt[] = [];

  try {
    at_block = await deps.block();
    const read = await deps.read(c, at_block);
    method = read.method;
    params = read.params;
    attempts = read.attempts;
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

  const a = agree(attempts);
  const exchanges: RpcExchange[] = attempts
    .filter((x): x is Extract<Attempt, { ok: true }> => x.ok)
    .map((x) => ({ provider: x.provider, method, params, result: x.result, at_block: x.at_block }));

  if (!a.agreed) {
    // UNREADABLE, and the failing answers are recorded verbatim. A disagreement
    // with the evidence discarded is an assertion; with it, it is a fact a
    // stranger can check.
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
