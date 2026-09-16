// Guards for the filing rule (issue #5).
//
// The rule: "if the registry cannot produce, from the predicate alone, a chain
// state that yields BROKEN, the commitment is refused." So the tests that
// matter most are the REFUSALS -- a gate that accepts everything is the defect
// this whole project is named after.

import test from "node:test";
import assert from "node:assert/strict";
import { file, cmpDec, isUnsignedDecimal, ZERO_ADDRESS, type Commitment } from "../src/commitment.ts";
import { evaluate } from "../src/evaluate.ts";

const SUBJ = "0x" + "aa".repeat(20);
const TOKEN = "0x" + "bb".repeat(20);
const WINDOW = { from: 1_700_000_000_000, to: 1_700_000_000_000 + 30 * 86_400_000 };

const c = (over: Partial<Commitment> = {}): Commitment => ({
  id: "c-1",
  predicate: { kind: "no-outbound-transfer", subject: SUBJ, token: TOKEN },
  window: WINDOW,
  ...over,
});

test("a breakable commitment is filed WITH the state that would break it", () => {
  // The witness is the product. Filing without publishing one would make the
  // rule unfalsifiable: nobody could check that the gate actually ran.
  //
  // Killing mutation: return { filed: true } with no witness from the
  // no-outbound-transfer branch. This goes red.
  const r = file(c());
  assert.equal(r.filed, true);
  assert.ok(r.filed && r.witness.transfers.length === 1, "the witness names a concrete transfer");
  assert.equal(r.filed && r.witness.transfers[0]!.from, SUBJ);
});

test("the witness is dated INSIDE the window", () => {
  // A break outside the window is not a break of this commitment, so a witness
  // outside it demonstrates nothing.
  //
  // Killing mutation: set at_time to Date.now() instead of window.from.
  const r = file(c());
  assert.ok(r.filed);
  const t = r.filed ? r.witness.transfers[0]!.at_time : 0;
  assert.ok(t >= WINDOW.from && t < WINDOW.to, `witness at ${t} is inside [${WINDOW.from}, ${WINDOW.to})`);
});

test("A FLOOR OF ZERO IS REFUSED, because an unsigned balance cannot go below it", () => {
  // The refusal this rule exists for. "I promise to hold at least nothing" is
  // a sentence that reads as a guarantee and guarantees nothing -- it would
  // report HELD forever, on every chain state that can exist.
  //
  // Killing mutation: delete the `below === null` branch. The commitment files
  // with a witness claiming a negative balance, which is not a chain state.
  const r = file(c({ predicate: { kind: "balance-floor", subject: SUBJ, token: TOKEN, floor: "0" } }));
  assert.equal(r.filed, false);
  assert.match(r.filed === false ? r.reason : "", /cannot be broken/);
  assert.match(r.filed === false ? r.reason : "", /unsigned/);
});

test("a real floor is filed, and the witness sits one unit below it", () => {
  const r = file(c({ predicate: { kind: "balance-floor", subject: SUBJ, token: TOKEN, floor: "1000" } }));
  assert.ok(r.filed);
  assert.equal(r.filed && r.witness.balances[SUBJ], "999");
});

test("the floor is decimal-string arithmetic, not a JS number", () => {
  // A uint256 does not fit in a double. If this used Number(), the witness for
  // a large floor would be silently wrong -- and it would be published as the
  // proof that the gate ran.
  //
  // Killing mutation: implement decMinusOne with Number(s) - 1.
  const big = "100000000000000000000000";
  const r = file(c({ predicate: { kind: "balance-floor", subject: SUBJ, token: TOKEN, floor: big } }));
  assert.ok(r.filed);
  assert.equal(r.filed && r.witness.balances[SUBJ], "99999999999999999999999");
});

test("a disclosure window longer than the commitment window is refused", () => {
  // It can never expire while the commitment is live, so no chain state breaks
  // it. Subtler than the zero floor and the same class.
  //
  // Killing mutation: delete the `p.hours >= windowHours` branch.
  const short = { from: WINDOW.from, to: WINDOW.from + 3_600_000 }; // one hour
  const r = file(c({ window: short, predicate: { kind: "disclosed-within", subject: SUBJ, token: TOKEN, hours: 24 } }));
  assert.equal(r.filed, false);
  assert.match(r.filed === false ? r.reason : "", /cannot expire inside/);
});

test("a disclosure window that fits is filed, with an undisclosed outflow as the witness", () => {
  const r = file(c({ predicate: { kind: "disclosed-within", subject: SUBJ, token: TOKEN, hours: 6 } }));
  assert.ok(r.filed);
  assert.ok(r.filed && r.witness.transfers.length === 1);
  assert.deepEqual(r.filed ? r.witness.disclosures : null, {}, "and nothing disclosed against it");
});

test("only-to names a concrete address outside the allowlist", () => {
  // "Find one" is not enough -- the witness has to BE one, or a reader cannot
  // check the gate ran.
  //
  // Killing mutation: skip the taken-set walk and always use `other`, then
  // pass `other` in the allowlist. This goes red.
  const other = "0x" + "11".repeat(20);
  const r = file(c({ predicate: { kind: "only-to", subject: SUBJ, token: TOKEN, allowed: [other] } }));
  assert.ok(r.filed);
  const to = r.filed ? r.witness.transfers[0]!.to : "";
  assert.notEqual(to, other, "the witness does not send to an allowed address");
  assert.notEqual(to, SUBJ);
});

test("an empty window is refused", () => {
  const r = file(c({ window: { from: WINDOW.from, to: WINDOW.from } }));
  assert.equal(r.filed, false);
  assert.match(r.filed === false ? r.reason : "", /window is empty/);
});

test("a malformed address is refused before anything else happens", () => {
  for (const bad of ["0xABC", "not-an-address", "0x" + "AA".repeat(20)]) {
    const r = file(c({ predicate: { kind: "no-outbound-transfer", subject: bad, token: null } }));
    assert.equal(r.filed, false, `${bad} must be refused`);
    assert.match(r.filed === false ? r.reason : "", /address/);
  }
});

test("an unknown predicate kind is refused, never defaulted", () => {
  // Same failure as reporting HELD when the chain could not be read: a
  // commitment this registry cannot evaluate must not be filed as if it could.
  const r = file(c({ predicate: { kind: "vibes", subject: SUBJ, token: null } as never }));
  assert.equal(r.filed, false);
  assert.match(r.filed === false ? r.reason : "", /unknown predicate kind/);
});

test("decimal comparison orders by magnitude, not lexically", () => {
  assert.equal(cmpDec("9", "10"), -1, "9 < 10 even though '9' > '1' lexically");
  assert.equal(cmpDec("1000", "999"), 1);
  assert.equal(cmpDec("42", "42"), 0);
  assert.equal(isUnsignedDecimal("007"), false, "leading zeros are not a canonical decimal");
});

test("no-new-mint files WITH a witness showing a mint from the zero address", () => {
  // A commitment that no new tokens are minted must produce a chain state where
  // a mint actually happens.
  //
  // Killing mutation: return { filed: true } with transfers: [] from the
  // no-new-mint branch.
  const r = file(c({ predicate: { kind: "no-new-mint", subject: SUBJ, token: TOKEN } }));
  assert.equal(r.filed, true);
  assert.ok(r.filed && r.witness.transfers.length === 1, "the witness names a concrete mint transfer");
  assert.equal(r.filed && r.witness.transfers[0]!.from, ZERO_ADDRESS);
  assert.equal(r.filed && r.witness.transfers[0]!.token, TOKEN);
  assert.equal(r.filed && r.witness.transfers[0]!.value, "1");
});

test("no-new-mint witness is dated INSIDE the window", () => {
  // A mint outside the window is not a break of this commitment.
  const r = file(c({ predicate: { kind: "no-new-mint", subject: SUBJ, token: TOKEN } }));
  assert.ok(r.filed);
  const t = r.filed ? r.witness.transfers[0]!.at_time : 0;
  assert.ok(t >= WINDOW.from && t < WINDOW.to, `witness at ${t} is inside [${WINDOW.from}, ${WINDOW.to})`);
});

test("no-new-mint refuses null token (native asset has no ERC-20 mint events)", () => {
  // The chain's native asset (ETH on Base) does not mint via ERC-20 Transfer
  // events from the zero address. "I promise no new native asset mints" would
  // report HELD forever because no ERC-20 log can ever break it.
  //
  // Killing mutation: delete the `p.token === null` refusal.
  const r = file(c({ predicate: { kind: "no-new-mint", subject: SUBJ, token: null as never } }));
  assert.equal(r.filed, false);
  assert.match(r.filed === false ? r.reason : "", /requires an ERC-20 token address/);
});

test("no-new-mint refuses zero address as token", () => {
  const r = file(c({ predicate: { kind: "no-new-mint", subject: SUBJ, token: ZERO_ADDRESS } }));
  assert.equal(r.filed, false);
  assert.match(r.filed === false ? r.reason : "", /token address cannot be the zero address/);
});

test("no-new-mint witness breaks its own predicate under evaluate", () => {
  const comm = c({ predicate: { kind: "no-new-mint", subject: SUBJ, token: TOKEN } });
  const r = file(comm);
  assert.ok(r.filed);
  const ev = evaluate(comm, r.witness, WINDOW.to);
  assert.equal(ev.verdict, "BROKEN");
  assert.equal(ev.reason, "mint transfer from zero address in window");
});
