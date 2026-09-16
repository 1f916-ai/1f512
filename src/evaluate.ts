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

import type { ChainState, Commitment, Transfer } from "./commitment.ts";
import { cmpDec, isUnsignedDecimal, ZERO_ADDRESS } from "./commitment.ts";
import type { Verdict } from "./reading.ts";

export interface Evaluation {
  verdict: Verdict;
  /** Machine-readable. Callers branch on this, never on prose. */
  reason: string;
  /** The transfer or balance that decided it, when one did. Evidence, not decoration. */
  evidence?: Transfer | { subject: string; balance: string; floor: string };
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
      for (const t of outflows) {
        const d = chain.disclosures?.[t.tx];
        if (d && d.at_time <= t.at_time + deadlineMs) continue; // disclosed in time
        // UNDISCLOSED, BUT IS IT LATE YET? An outflow with no disclosure is not
        // a break until its deadline has passed at T. Reporting BROKEN the
        // instant a transfer lands would punish someone who is still inside the
        // window they were given, and the whole point of this predicate is that
        // the window exists.
        if (T > t.at_time + deadlineMs) {
          return {
            verdict: "DEFAULTED",
            reason: d ? "disclosure arrived after the deadline" : "outflow never disclosed within the window",
            evidence: t,
          };
        }
      }
      return heldOrOpen(c, T, outflows.length ? "every outflow disclosed, or still inside its window" : "no outflow to disclose");
    }

    case "no-new-mint": {
      if (!chain.transfers) {
        return { verdict: "UNREADABLE", reason: "no transfers in this chain state" };
      }
      for (const t of chain.transfers) {
        if (t.token !== p.token || t.from !== ZERO_ADDRESS || !inWindow(t.at_time, c)) {
          continue;
        }
        if (!isUnsignedDecimal(t.value)) {
          return { verdict: "UNREADABLE", reason: `unparseable transfer value ${JSON.stringify(t.value)}` };
        }
        if (cmpDec(t.value, "0") > 0) {
          return { verdict: "BROKEN", reason: "mint transfer from zero address in window", evidence: t };
        }
      }
      return heldOrOpen(c, T, "no mint transfer seen in window");
    }
  }

  // An unknown kind is UNREADABLE, never HELD. The registry saying "I do not
  // know what this commitment means" must never look like "this commitment is
  // being kept".
  return { verdict: "UNREADABLE", reason: `unknown predicate kind ${JSON.stringify((p as { kind: string }).kind)}` };
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
