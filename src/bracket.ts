// Build Disclosure brackets from the watcher's own reading rows (issue #31,
// the half PR #32 left open: nothing writes `disclosures` yet).
//
// The contract from commitment.ts: both bounds of a bracket are at_times of
// the watcher's own hash-chained reading rows — the last row that LACKED the
// disclosure and the first row that CARRIED it. This file computes that pair
// from the rows. It adds one rule of its own:
//
//   THE BUILDER NEVER REPAIRS. If the rows tell a crooked story — a disclosure
//   seen, then gone, then back — the bracket this returns is the literal pair
//   the contract names (last row without, first row with), which is then out
//   of order, and evaluate() already refuses a malformed bracket as
//   UNREADABLE. Smoothing the flap into a clean bracket here would decide, in
//   a build step nobody audits, the exact question the verdict set exists to
//   answer in the open. The flap is also reported as an anomaly, because a
//   refused bracket says "could not place the arrival" and the caller deserves
//   to know the real reason is worse: the channel contradicted itself.
//
// What this file deliberately does not know: WHERE disclosures live. No
// channel for them exists yet (on-chain event, signed file, anything), so the
// caller supplies what each row saw. When the channel is chosen, the adapter
// from a Reading to a Sighting is the only code that learns its shape.

import type { Disclosure } from "./commitment.ts";

/** What one chained reading row saw of the disclosure channel. */
export interface Sighting {
  /**
   * The row's read_at. This is the bracket bound, and it must come from a row
   * in the watcher's verified chain — that is what makes the bracket worth
   * more than testimony: backdating a bound means rewriting the chain.
   */
  at_time: number;
  /** Tx hashes whose disclosures this row carried. */
  disclosed: readonly string[];
  /** The subject's own claimed_at per tx, where the row recorded one. Testimony. */
  claimed?: Readonly<Record<string, number>>;
}

export interface BracketAnomaly {
  tx: string;
  problem: "flap";
  detail: string;
}

export interface BuiltBrackets {
  /** By tx hash, shaped for ChainState.disclosures. */
  disclosures: Record<string, Disclosure>;
  /** Nothing here is silently dropped; a crooked channel is reported, not smoothed. */
  anomalies: BracketAnomaly[];
}

/**
 * Compute disclosure brackets from sightings in chain order.
 *
 * Sightings must arrive in non-decreasing at_time order, and this throws
 * rather than sorts when they do not: these rows come from the caller's own
 * verified log, where out-of-order read_at is already "a rewritten log"
 * (reading.ts), so re-ordering them here would quietly tidy the one symptom
 * the verifier is built to report.
 *
 * A tx never sighted gets no entry at all — evaluate() reads a missing entry
 * through the chain-state at_time rule (silence is only evidence as of when it
 * was heard), and an empty bracket could not say that better.
 *
 * A ROW THAT COULD NOT READ THE CHANNEL MUST NOT BE A SIGHTING. Absence in a
 * row is evidence only because the row looked and did not see. A cycle whose
 * providers were unreachable proves nothing about absence, so the adapter
 * building Sightings has to skip it — passing it in as `disclosed: []` would
 * manufacture an absent_at bound out of a failure to look. That rule cannot
 * be enforced here (this file cannot tell "looked, empty" from "did not
 * look"), which is why it is written at the type boundary instead.
 */
export function buildBrackets(sightings: readonly Sighting[]): BuiltBrackets {
  let prev = -Infinity;
  for (const s of sightings) {
    if (s.at_time < prev) {
      throw new Error(
        `sightings out of order: at_time ${s.at_time} after ${prev}. ` +
          `Rows from a verified chain are already ordered; do not sort around a broken one.`,
      );
    }
    prev = s.at_time;
  }

  // For every tx ever carried: the first row that carried it, the last row
  // that lacked it, and the testimony at first carry. Two passes, because the
  // rows that matter most for absent_at are the ones BEFORE a tx was ever
  // seen — a one-pass walk that only tracks already-seen txs misses exactly
  // those and reports every bracket as never-observed-absent. Walking every
  // known tx per row is quadratic in the worst case and fine at this
  // registry's scale; the honest version first, a clever one when a log is
  // actually too long for it.
  const txs = new Set<string>();
  for (const s of sightings) for (const tx of s.disclosed) txs.add(tx);

  const firstWith = new Map<string, number>();
  const lastWithout = new Map<string, number>();
  const claimed = new Map<string, number>();
  for (const s of sightings) {
    const carried = new Set(s.disclosed);
    for (const tx of txs) {
      if (!carried.has(tx)) {
        lastWithout.set(tx, s.at_time);
      } else if (!firstWith.has(tx)) {
        firstWith.set(tx, s.at_time);
        const c = s.claimed?.[tx];
        if (c !== undefined) claimed.set(tx, c);
      }
    }
  }

  const disclosures: Record<string, Disclosure> = {};
  const anomalies: BracketAnomaly[] = [];
  for (const [tx, present_at] of firstWith) {
    const absent_at = lastWithout.get(tx) ?? null;
    if (absent_at !== null && absent_at >= present_at) {
      anomalies.push({
        tx,
        problem: "flap",
        detail:
          `disclosure carried at ${present_at} but lacking again at ${absent_at}; ` +
          `the bracket below is malformed on purpose and evaluate() will refuse it`,
      });
    }
    disclosures[tx] = {
      absent_at,
      present_at,
      ...(claimed.has(tx) ? { claimed_at: claimed.get(tx)! } : {}),
    };
  }
  return { disclosures, anomalies };
}
