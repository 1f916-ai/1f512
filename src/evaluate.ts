// The verdict, as a pure function of (stored row, chain state, T). Issue #4.
//
// The proposal's constraint, quoted: an entry's state is a "pure function of
// (stored row, chain, T)", computed when someone READS it -- not written by a
// background job.
//
// Why that is the whole design and not an implementation detail: if a live
// writer has to mark something DEFAULTED, then an operator who goes down
// produces a registry that quietly reports everything as fine. Silence from the
// watcher reads as reassurance, which is the exact failure this project exists
// to end. With the clock in the read path, operator uptime delays DISCOVERY and
// never changes whether a default exists.
//
// The drill this has to survive: kill every writer mid-window, and pages must
// still be correct and correctly dated before anything restarts.
//
// So: no Date.now() anywhere in this file. T is an argument. A reader supplies
// it, a test supplies it, and the answer is the same either way.

import type { ChainState, Commitment, Disclosure, Transfer } from "./commitment.ts";
import { cmpDec } from "./commitment.ts";
import type { Verdict } from "./reading.ts";

export interface Evaluation {
  verdict: Verdict;
  /** Machine-readable. Callers branch on this, never on prose. */
  reason: string;
  /** The transfer or balance that decided it, when one did. Evidence, not decoration. */
  evidence?:
    | Transfer
    | { subject: string; balance: string; floor: string }
    | { tx: string; deadline: number; absent_at: number | null; present_at: number };
}

/** Is a transfer inside this commitment's window? */
function inWindow(t: number, c: Commitment): boolean {
  return t >= c.window.from && t < c.window.to;
}

/**
 * Evaluate one commitment against one chain state at time T.
 *
 * Returns BROKEN the moment the chain shows a break, regardless of T: a break
 * that happened does not un-happen because you read the page later.
 *
 * Returns DEFAULTED when the window has closed at T and the commitment required
 * something that never arrived.
 *
 * Returns HELD only when the chain was read and showed no break. A caller that
 * could not read the chain must not call this at all -- that is UNREADABLE, and
 * it is decided in agreement.ts, before anything here runs.
 */
export function evaluate(c: Commitment, chain: ChainState, T: number): Evaluation {
  const p = c.predicate;
  const subject = p.subject;

  switch (p.kind) {
    case "no-outbound-transfer": {
      const bad = chain.transfers.find(
        (t) => t.from === subject && t.token === p.token && inWindow(t.at_time, c),
      );
      if (bad) return { verdict: "BROKEN", reason: "outbound transfer in window", evidence: bad };
      return heldOrOpen(c, T, "no outbound transfer seen in window");
    }

    case "balance-floor": {
      const bal = chain.balances[subject];
      // A BALANCE WE DO NOT HAVE IS NOT A BALANCE OF ZERO. Absence of a
      // derivation is not proof of zero: reading a missing balance as 0 would
      // report BROKEN against someone whose balance we simply failed to fetch,
      // which is a false accusation published permanently.
      if (bal === undefined) {
        return { verdict: "UNREADABLE", reason: "no balance for subject in this chain state" };
      }
      if (cmpDec(bal, p.floor) < 0) {
        return {
          verdict: "BROKEN",
          reason: "balance below floor",
          evidence: { subject, balance: bal, floor: p.floor },
        };
      }
      return heldOrOpen(c, T, "balance at or above floor");
    }

    case "only-to": {
      const allowed = new Set(p.allowed);
      const bad = chain.transfers.find(
        (t) => t.from === subject && t.token === p.token && inWindow(t.at_time, c) && !allowed.has(t.to),
      );
      if (bad) return { verdict: "BROKEN", reason: "transfer to an address outside the allowlist", evidence: bad };
      return heldOrOpen(c, T, "no transfer left the allowlist");
    }

    case "disclosed-within": {
      const deadlineMs = p.hours * 3_600_000;
      const outflows = chain.transfers.filter(
        (t) => t.from === subject && t.token === p.token && inWindow(t.at_time, c),
      );
      // Scan every outflow before answering: a provable default anywhere beats
      // an undecidable bracket elsewhere, because DEFAULTED is a statement
      // about the subject and UNREADABLE is a statement about the instrument.
      let undecidable: Evaluation | null = null;
      for (const t of outflows) {
        const D = t.at_time + deadlineMs;
        const d = chain.disclosures?.[t.tx];

        if (d) {
          const verdict = decideBracket(t.tx, d, D);
          if (verdict === null) continue; // provably in time
          if (verdict.verdict === "DEFAULTED") return verdict;
          undecidable ??= verdict;
          continue;
        }

        // UNDISCLOSED, BUT IS IT LATE YET? An outflow with no disclosure is not
        // a break until its deadline has passed at T. Reporting BROKEN the
        // instant a transfer lands would punish someone who is still inside the
        // window they were given, and the whole point of this predicate is that
        // the window exists.
        if (T <= D) continue;

        // SILENCE IS ONLY EVIDENCE AS OF WHEN IT WAS HEARD. The disclosure set
        // in this chain state is complete as of at_time, not as of T. A row
        // read before the deadline proves nothing about a disclosure that
        // arrived after the read, so deciding this on T alone would publish a
        // false accusation from a stale snapshot -- the same failure as reading
        // a missing balance as zero.
        if (chain.at_time > D) {
          return { verdict: "DEFAULTED", reason: "outflow never disclosed within the window", evidence: t };
        }
        undecidable ??= {
          verdict: "UNREADABLE",
          reason: "chain state predates the disclosure deadline; silence after the read was not observed",
          evidence: t,
        };
      }
      if (undecidable) return undecidable;
      return heldOrOpen(c, T, outflows.length ? "every outflow disclosed, or still inside its window" : "no outflow to disclose");
    }
  }

  // An unknown kind is UNREADABLE, never HELD. The registry saying "I do not
  // know what this commitment means" must never look like "this commitment is
  // being kept".
  return { verdict: "UNREADABLE", reason: `unknown predicate kind ${JSON.stringify((p as { kind: string }).kind)}` };
}

/**
 * Decide one disclosure bracket against its deadline D (issue #31).
 *
 * Returns null when the disclosure provably arrived in time, DEFAULTED when it
 * provably arrived late, and UNREADABLE when the watcher's cadence could not
 * place the arrival on one side of D. The straddle is an instrument failure --
 * the cadence was too coarse to answer -- and this registry already has a
 * verdict for "the instrument could not answer". It must never read as HELD.
 *
 * `claimed_at` is deliberately not consulted: the subject controls any time it
 * writes into a disclosure. Testimony is recorded, never decides.
 */
function decideBracket(tx: string, d: Disclosure, D: number): Evaluation | null {
  const bracket = { tx, deadline: D, absent_at: d.absent_at, present_at: d.present_at };
  // A bracket whose bounds are out of order proves nothing in either direction.
  if (d.absent_at !== null && d.absent_at >= d.present_at) {
    return { verdict: "UNREADABLE", reason: "malformed disclosure bracket: absent_at is not before present_at", evidence: bracket };
  }
  if (d.present_at <= D) return null; // a chained row carried it at or before the deadline
  if (d.absent_at !== null && d.absent_at > D) {
    // A chained row PAST the deadline still lacked it: provably late. Strictly
    // past, because the deadline is inclusive (present_at <= D is in time), so
    // a row at exactly D lacking it leaves an arrival AT D still possible. This
    // is the same boundary the never-disclosed path draws with chain.at_time > D;
    // the two paths must convict on the same fact or neither.
    return { verdict: "DEFAULTED", reason: "disclosure arrived after the deadline", evidence: bracket };
  }
  // The bracket straddles D (or the disclosure was never observed absent and
  // first appeared after D). The arrival cannot be placed.
  return { verdict: "UNREADABLE", reason: "disclosure arrival not decidable at this cadence", evidence: bracket };
}

/**
 * Nothing broke. Say whether the commitment is still running or finished
 * cleanly -- both are HELD, and the distinction belongs in the reason so a
 * reader can tell a promise that survived from one still being tested.
 */
function heldOrOpen(c: Commitment, T: number, why: string): Evaluation {
  return {
    verdict: "HELD",
    reason: T >= c.window.to ? `${why}; window closed` : `${why}; window open`,
  };
}
