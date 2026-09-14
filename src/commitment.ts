// What a commitment IS, and the rule that decides whether it may be filed.
//
// The selected proposal's filing rule, quoted:
//
//   "if the registry cannot produce, from the predicate alone, a chain state
//    that yields BROKEN, the commitment is refused. A check that could not
//    have failed is not a check."
//
// That rule is the reason this file puts the predicate types and the filing
// gate in one place. The gate is not a validator bolted on afterwards; it is a
// question each predicate must be able to answer about itself: SHOW ME THE
// CHAIN STATE THAT BREAKS YOU. A predicate that cannot produce one is not
// refused because a rule says so, it is refused because there is nothing there.
//
// So `witness()` is not a test helper. It is the load-bearing method, and every
// predicate added later has to implement it or it cannot be filed.

export type Address = string; // 0x + 40 hex, lowercased at construction

/** A concrete chain state. This is what a witness returns and what an evaluator reads. */
export interface ChainState {
  /** Block the state was observed at. */
  at_block: number;
  /** Observation time, ms since epoch. Used by time-dependent predicates. */
  at_time: number;
  /** ERC-20 style transfers visible in the window, oldest first. */
  transfers: Transfer[];
  /** Balances by address, as decimal STRINGS. Never numbers -- see reading.ts. */
  balances: Record<Address, string>;
  /** Disclosures the subject published, keyed by the tx hash they refer to. */
  disclosures?: Record<string, { at_time: number }>;
}

export interface Transfer {
  tx: string;
  from: Address;
  to: Address;
  token: Address | null; // null = the chain's native asset
  /** Decimal string. A uint256 does not fit in a JS number. */
  value: string;
  at_block: number;
  at_time: number;
}

export interface Window {
  /** ms since epoch, inclusive. */
  from: number;
  /** ms since epoch, exclusive. */
  to: number;
}

// ---------------------------------------------------------------------------
// Predicates
// ---------------------------------------------------------------------------

export type Predicate =
  | { kind: "no-outbound-transfer"; subject: Address; token: Address | null }
  | { kind: "balance-floor"; subject: Address; token: Address | null; floor: string }
  | { kind: "only-to"; subject: Address; token: Address | null; allowed: Address[] }
  | { kind: "disclosed-within"; subject: Address; token: Address | null; hours: number };

export interface Commitment {
  id: string;
  predicate: Predicate;
  window: Window;
  /** Signature by the key controlling `predicate.subject`. Not verified here. */
  sig?: string;
}

// ---------------------------------------------------------------------------
// The filing rule
// ---------------------------------------------------------------------------

export interface Refusal {
  filed: false;
  reason: string;
}

export interface Filed {
  filed: true;
  /** The chain state that would break this commitment. Published with it. */
  witness: ChainState;
}

export type FilingResult = Filed | Refusal;

const HEX40 = /^0x[0-9a-f]{40}$/;

function addressProblem(a: Address, label: string): string | null {
  if (typeof a !== "string" || !HEX40.test(a)) {
    return `${label} must be a lowercase 0x-prefixed 20-byte address, got ${JSON.stringify(a)}`;
  }
  return null;
}

// Decimal-string comparison, because these are uint256 values that do not fit
// in a JS number. Compare by length first, then lexically -- both operands are
// unsigned integers with no leading zeros, so that is a total order.
function isUnsignedDecimal(s: string): boolean {
  return typeof s === "string" && /^(0|[1-9][0-9]*)$/.test(s);
}

function cmpDec(a: string, b: string): number {
  if (a.length !== b.length) return a.length < b.length ? -1 : 1;
  return a === b ? 0 : a < b ? -1 : 1;
}

function decMinusOne(s: string): string | null {
  if (s === "0") return null; // nothing below zero: the caller must refuse
  const digits = s.split("");
  let i = digits.length - 1;
  while (i >= 0) {
    if (digits[i] !== "0") {
      digits[i] = String(Number(digits[i]) - 1);
      break;
    }
    digits[i] = "9";
    i--;
  }
  const out = digits.join("").replace(/^0+(?=\d)/, "");
  return out;
}

/**
 * THE GATE. Either produce the chain state that breaks this commitment, or
 * refuse it and say why.
 *
 * Every refusal here is a commitment somebody wanted to make and could not.
 * The message is written for that person, because a refusal they cannot act on
 * is indistinguishable from the registry being broken.
 */
export function file(c: Commitment): FilingResult {
  const p = c.predicate;

  if (!c.id || typeof c.id !== "string") return { filed: false, reason: "a commitment needs an id" };
  if (!Number.isSafeInteger(c.window.from) || !Number.isSafeInteger(c.window.to)) {
    return { filed: false, reason: "window bounds must be millisecond timestamps" };
  }
  // A window that has already closed, or has no interior, can never be broken
  // DURING it. The commitment would be decoration from the moment it was filed.
  if (c.window.to <= c.window.from) {
    return { filed: false, reason: `window is empty: from ${c.window.from} is not before to ${c.window.to}` };
  }

  const subjErr = addressProblem(p.subject, "subject");
  if (subjErr) return { filed: false, reason: subjErr };
  if (p.token !== null) {
    const tokErr = addressProblem(p.token, "token");
    if (tokErr) return { filed: false, reason: tokErr };
  }

  // The witness is dated INSIDE the window on purpose. A break that falls
  // outside the window is not a break of this commitment, so a witness outside
  // it would not demonstrate what it claims to.
  const at_time = c.window.from;
  const at_block = 1;
  const other: Address = "0x" + "11".repeat(20);

  switch (p.kind) {
    case "no-outbound-transfer": {
      // Always breakable: any outbound transfer in the window does it.
      return {
        filed: true,
        witness: {
          at_block,
          at_time,
          balances: {},
          transfers: [
            { tx: "0x" + "22".repeat(32), from: p.subject, to: other, token: p.token, value: "1", at_block, at_time },
          ],
        },
      };
    }

    case "balance-floor": {
      if (!isUnsignedDecimal(p.floor)) {
        return { filed: false, reason: `floor must be an unsigned decimal string, got ${JSON.stringify(p.floor)}` };
      }
      // THE REFUSAL THIS PREDICATE EXISTS TO DEMONSTRATE. A floor of zero on an
      // unsigned balance cannot be gone below: there is no chain state where
      // the balance is negative. "I promise to hold at least nothing" is a
      // sentence, not a check, and it is exactly the shape of a commitment that
      // looks reassuring and guarantees nothing.
      const below = decMinusOne(p.floor);
      if (below === null) {
        return {
          filed: false,
          reason:
            "a floor of 0 cannot be broken: token balances are unsigned, so no chain state puts this balance below zero. " +
            "This commitment would always read HELD. Raise the floor to an amount you would actually be embarrassed to fall below.",
        };
      }
      return { filed: true, witness: { at_block, at_time, balances: { [p.subject]: below }, transfers: [] } };
    }

    case "only-to": {
      if (!Array.isArray(p.allowed)) return { filed: false, reason: "allowed must be a list of addresses" };
      for (const a of p.allowed) {
        const e = addressProblem(a, "allowed entry");
        if (e) return { filed: false, reason: e };
      }
      // Find an address outside the allowlist to send to. With a finite
      // allowlist this always exists -- the address space is 2^160 -- but the
      // witness has to name a CONCRETE one, so walk until we find a free one
      // rather than asserting that one exists.
      let candidate = other;
      let n = 0;
      const taken = new Set([...p.allowed, p.subject]);
      while (taken.has(candidate)) {
        n++;
        candidate = "0x" + n.toString(16).padStart(40, "0");
      }
      return {
        filed: true,
        witness: {
          at_block,
          at_time,
          balances: {},
          transfers: [
            { tx: "0x" + "33".repeat(32), from: p.subject, to: candidate, token: p.token, value: "1", at_block, at_time },
          ],
        },
      };
    }

    case "disclosed-within": {
      if (!Number.isFinite(p.hours) || p.hours < 0) {
        return { filed: false, reason: "hours must be a non-negative number" };
      }
      // A disclosure window longer than the commitment window can never expire
      // inside it, so the commitment cannot be broken while it is live.
      const windowHours = (c.window.to - c.window.from) / 3_600_000;
      if (p.hours >= windowHours) {
        return {
          filed: false,
          reason:
            `a disclosure window of ${p.hours}h cannot expire inside a commitment window of ${windowHours.toFixed(2)}h, ` +
            "so no chain state breaks this while it is live. Shorten the disclosure window or lengthen the commitment.",
        };
      }
      // Witness: an outflow, and no disclosure, at a time past the deadline.
      const outAt = c.window.from;
      return {
        filed: true,
        witness: {
          at_block,
          at_time: outAt + p.hours * 3_600_000 + 1,
          balances: {},
          disclosures: {},
          transfers: [
            { tx: "0x" + "44".repeat(32), from: p.subject, to: other, token: p.token, value: "1", at_block, at_time: outAt },
          ],
        },
      };
    }
  }

  // An unknown predicate kind is refused rather than defaulted. A commitment
  // this registry cannot evaluate must never be filed as if it could be: that
  // is the same failure as reporting HELD when the chain could not be read.
  return { filed: false, reason: `unknown predicate kind ${JSON.stringify((p as { kind: string }).kind)}` };
}

export { cmpDec, isUnsignedDecimal };
