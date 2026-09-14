// Two independent reads of the same chain state, and what to conclude (issue #3).
//
// The proposal's rule, quoted: "two RPCs; disagreement or failure is UNREADABLE
// and is published, never defaulted to HELD."
//
// That sentence is the whole defect this project exists to avoid. A monitor
// that cannot see the chain, and reports HELD because nothing looked broken,
// manufactures evidence of a promise being kept out of its own blindness. It is
// worse than no monitor, because a reader takes silence from a watcher as
// reassurance.
//
// So this file has one rule that overrides every other consideration: an answer
// is produced ONLY when two independent reads agree. Everything else is
// UNREADABLE, and UNREADABLE is published.

import { canonical, type RpcExchange, type Verdict } from "./reading.ts";

/** One provider's attempt. Either it answered, or it did not. */
export type Attempt =
  | { provider: string; ok: true; result: unknown; at_block: number }
  | { provider: string; ok: false; error: string };

export interface Agreement {
  agreed: boolean;
  /** The agreed result, present only when agreed is true. */
  result?: unknown;
  at_block?: number;
  /** Machine-readable. Callers branch on this, never on prose. */
  reason:
    | "agreed"
    | "disagreed"
    | "one_failed"
    | "all_failed"
    | "too_few_providers"
    | "same_provider_twice";
  /** Every attempt, kept verbatim. A disagreement is evidence, not an error. */
  attempts: Attempt[];
}

/**
 * Decide what two or more reads mean.
 *
 * Deliberately NOT here: any I/O, any retry, any scheduling, any notion of
 * which provider is "better". A caller that wants to prefer one endpoint over
 * another is asking for a single-source answer, which is the thing this exists
 * to refuse.
 */
export function agree(attempts: Attempt[]): Agreement {
  // TWO DIFFERENT PROVIDERS, not two requests. Asking the same endpoint twice
  // and calling the matching answers agreement is single-sourcing with extra
  // steps: one wrong node, one stale cache, one compromised host answers both
  // and the log records consensus. This is the cheapest mistake to make here
  // and the hardest to see afterwards, because the record looks correct.
  const labels = new Set(attempts.map((a) => a.provider));
  if (attempts.length < 2) {
    return { agreed: false, reason: "too_few_providers", attempts };
  }
  if (labels.size < attempts.length) {
    return { agreed: false, reason: "same_provider_twice", attempts };
  }

  const answered = attempts.filter((a): a is Extract<Attempt, { ok: true }> => a.ok);

  // ALL FAILED IS NOT HELD. Writing this branch first, and testing it first,
  // because it is the one that has to be got right: a watcher that cannot see
  // must say so.
  if (answered.length === 0) return { agreed: false, reason: "all_failed", attempts };
  if (answered.length < attempts.length) return { agreed: false, reason: "one_failed", attempts };

  // Compare by canonical form, not by reference or by JSON.stringify: two
  // providers serialise the same object with different key order routinely, and
  // calling that a disagreement would make the log useless. canonical() also
  // refuses a value that cannot survive a round trip, which is the right place
  // for that to fail -- before it reaches the record.
  const first = canonical(answered[0]!.result);
  const allSame = answered.every((a) => canonical(a.result) === first);
  if (!allSame) return { agreed: false, reason: "disagreed", attempts };

  // Block heights must match too. Two providers agreeing about DIFFERENT blocks
  // is not agreement about anything; it is two facts that happen to look alike.
  const blocks = new Set(answered.map((a) => a.at_block));
  if (blocks.size !== 1) return { agreed: false, reason: "disagreed", attempts };

  return { agreed: true, result: answered[0]!.result, at_block: answered[0]!.at_block, reason: "agreed", attempts };
}

/**
 * The verdict a disagreement forces, for callers that want it stated rather
 * than implied. There is exactly one: no amount of disagreement ever produces
 * HELD or BROKEN.
 */
export function verdictFor(a: Agreement): Verdict | null {
  return a.agreed ? null : "UNREADABLE";
}

/** Turn attempts into the exchanges a reading record publishes. */
export function toExchanges(method: string, params: unknown[], a: Agreement): RpcExchange[] {
  return a.attempts
    .filter((x): x is Extract<Attempt, { ok: true }> => x.ok)
    .map((x) => ({ provider: x.provider, method, params, result: x.result, at_block: x.at_block }));
}
