// Guards for the filing rule (issue #5).
//
// The rule: "if the registry cannot produce, from the predicate alone, a chain
// state that yields BROKEN, the commitment is refused." So the tests that
// matter most are the REFUSALS -- a gate that accepts everything is the defect
// this whole project is named after.

import test from "node:test";
import assert from "node:assert/strict";
import { file, cmpDec, isUnsignedDecimal, canonicalFiling, renderFiling, type Commitment } from "../src/commitment.ts";
import { signFiling } from "../src/sign.ts";

const ALICE_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
const ALICE = "0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266";
const BOB_KEY = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";
const BOB = "0x70997970c51812dc3a010c7d01b50e0d17dc79c8";

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

// ---------------------------------------------------------------------------
// Key-bound filing: telling self-signed from third-party claims (issue #16)
// ---------------------------------------------------------------------------

test("an unsigned commitment files as a third-party claim", () => {
  // A missing signature must never render as absence of a claim. Unsigned is
  // a real filing with a known author problem: someone filed about this address.
  const r = file(c());
  assert.equal(r.filed, true);
  assert.equal(r.tier, "third-party");
  assert.equal(r.provenance, "third-party");
  assert.equal("signer" in r, false);
  assert.match(renderFiling(r), /third-party/);
});

test("a commitment with a valid subject signature files as self-signed", () => {
  const commitment: Commitment = {
    id: "c-alice-1",
    predicate: { kind: "no-outbound-transfer", subject: ALICE, token: TOKEN },
    window: WINDOW,
  };
  const sig = signFiling(commitment, ALICE_KEY);
  const r = file({ ...commitment, sig });

  assert.equal(r.filed, true);
  assert.equal(r.tier, "self-signed");
  assert.equal(r.provenance, "self-signed");
  assert.equal(r.signer, ALICE);
  assert.match(renderFiling(r), /self-signed/);
  assert.match(renderFiling(r), new RegExp(ALICE));
});

test("a third-party filing renders differently from a self-signed one", () => {
  // Anti-vacuity test: the registry must visibly distinguish between a commitment
  // the subject signed and a claim someone else filed about them.
  //
  // Killing mutation: if the recovered-address comparison is stripped, or if
  // tier/provenance is not assigned, this goes red.
  const selfCommitment: Commitment = {
    id: "c-alice-signed",
    predicate: { kind: "no-outbound-transfer", subject: ALICE, token: TOKEN },
    window: WINDOW,
  };
  const selfSig = signFiling(selfCommitment, ALICE_KEY);
  const selfFiled = file({ ...selfCommitment, sig: selfSig });

  const thirdPartyCommitment: Commitment = {
    id: "c-alice-unsigned",
    predicate: { kind: "no-outbound-transfer", subject: ALICE, token: TOKEN },
    window: WINDOW,
  };
  const thirdPartyFiled = file(thirdPartyCommitment);

  assert.ok(selfFiled.filed && thirdPartyFiled.filed);

  // Different fields and different values on every surface
  assert.notEqual(selfFiled.tier, thirdPartyFiled.tier);
  assert.equal(selfFiled.tier, "self-signed");
  assert.equal(thirdPartyFiled.tier, "third-party");

  assert.notEqual(selfFiled.provenance, thirdPartyFiled.provenance);
  assert.equal(selfFiled.provenance, "self-signed");
  assert.equal(thirdPartyFiled.provenance, "third-party");

  assert.equal(selfFiled.signer, ALICE);
  assert.equal("signer" in thirdPartyFiled, false);

  assert.notEqual(renderFiling(selfFiled), renderFiling(thirdPartyFiled));
  assert.match(renderFiling(selfFiled), /self-signed/);
  assert.match(renderFiling(thirdPartyFiled), /third-party/);

  assert.notEqual(JSON.stringify(selfFiled), JSON.stringify(thirdPartyFiled));

  // A third party cannot forge self-signed status for Alice by signing with Bob's key:
  const forgedCommitment: Commitment = {
    id: "c-alice-forged",
    predicate: { kind: "no-outbound-transfer", subject: ALICE, token: TOKEN },
    window: WINDOW,
  };
  const forgedSig = signFiling(forgedCommitment, BOB_KEY);
  const forgedResult = file({ ...forgedCommitment, sig: forgedSig });
  assert.equal(forgedResult.filed, false);
});

test("a filing whose signature recovers to a different address than the subject MUST be refused", () => {
  // Bob signs a commitment claiming Alice is the subject. The registry must refuse it:
  // a signature that is genuine but about someone else cannot be filed.
  //
  // Killing mutation: delete the recovered !== p.subject check in file().
  // This goes red because the filing would succeed instead of being refused.
  const commitment: Commitment = {
    id: "c-fake-alice",
    predicate: { kind: "no-outbound-transfer", subject: ALICE, token: TOKEN },
    window: WINDOW,
  };
  const bobSig = signFiling(commitment, BOB_KEY);
  const r = file({ ...commitment, sig: bobSig });

  assert.equal(r.filed, false);
  assert.match(r.filed === false ? r.reason : "", /signature was made by 0x70997970c51812dc3a010c7d01b50e0d17dc79c8, not subject 0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266/);
});

test("a filing with a malformed signature is refused", () => {
  // Truncated signature
  const r1 = file(c({ sig: "0x1234" }));
  assert.equal(r1.filed, false);
  assert.match(r1.filed === false ? r1.reason : "", /65-byte hex/);

  // Non-hex signature
  const r2 = file(c({ sig: "not-a-valid-hex-signature" }));
  assert.equal(r2.filed, false);
  assert.match(r2.filed === false ? r2.reason : "", /signature is invalid/);

  // Corrupted signature (bad r/s/v)
  const r3 = file(c({ sig: "0x" + "00".repeat(65) }));
  assert.equal(r3.filed, false);
  assert.match(r3.filed === false ? r3.reason : "", /out of range/);
});

test("a signature taken over a DIFFERENT commitment is refused", () => {
  // Replaying Alice's signature from c1 onto c2 (different id) alters the canonical filing,
  // so the signature recovers to an unrelated address and fails the subject check.
  const c1: Commitment = {
    id: "c-1",
    predicate: { kind: "no-outbound-transfer", subject: ALICE, token: TOKEN },
    window: WINDOW,
  };
  const sig1 = signFiling(c1, ALICE_KEY);
  const c2: Commitment = { ...c1, id: "c-2", sig: sig1 };
  const r = file(c2);

  assert.equal(r.filed, false);
  assert.match(r.filed === false ? r.reason : "", /not subject/);
});

test("a self-signed commitment with an unfalsifiable predicate is STILL refused", () => {
  // INVARIANT: A verified signature must NEVER change a verdict or filing rule.
  // It says who made the promise, never whether the check could have failed.
  // A floor of zero is unfalsifiable and must be refused even when signed by the subject.
  const impossible: Commitment = {
    id: "c-impossible",
    predicate: { kind: "balance-floor", subject: ALICE, token: TOKEN, floor: "0" },
    window: WINDOW,
  };
  const sig = signFiling(impossible, ALICE_KEY);
  const r = file({ ...impossible, sig });

  assert.equal(r.filed, false);
  assert.match(r.filed === false ? r.reason : "", /cannot be broken/);
});

test("the canonical filing is independent of property key order", () => {
  const cA: Commitment = {
    id: "c-1",
    predicate: { kind: "balance-floor", subject: ALICE, token: TOKEN, floor: "100" },
    window: { from: 1000, to: 2000 },
  };
  const cB: Commitment = {
    window: { to: 2000, from: 1000 },
    id: "c-1",
    predicate: { floor: "100", token: TOKEN, subject: ALICE, kind: "balance-floor" },
  };
  assert.equal(canonicalFiling(cA), canonicalFiling(cB));
});
