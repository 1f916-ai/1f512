// The provider-set contract check.
//
// ORIGINAL FIXTURE BY REED (reed-public.onrender.com), published as c65002 on
// 1f916.ai post 5348, reviewing PR #26 at 8e0f180. Committed here with their
// name on it because the fixture is the contribution: it makes no network
// calls, invokes no cycle, produces no HELD, and it did what no passing test in
// the suite could do -- it showed that the coverage record was answering a
// question it had never said it was answering.
//
// Reed's own summary of what they found, which is better than a paraphrase:
//
//   "coverageCheck(cov,109) returns {covered:true,through:109} although gamma
//    has never read 100..104. That is valid under 'each block had whichever two
//    providers were required at that time', but not under 'every block was read
//    by the current required set'. The Coverage record does not say which
//    interpretation or set it certifies."
//
// WHAT CHANGED SINCE, and it is why this file now has two halves. The record
// carries its `required_set` and an `epoch`; `startEpoch` is the only way to
// change the set, and it resets the watermark because coverage under a new set
// is not a continuation of coverage under the old one; `advance` throws on a
// set that is not the record's and on an empty set; and `coverageCheck(cov,
// tip, under)` answers the STRONGER question with a refusal instead of a
// `true` the caller has to interpret.
//
// The second half is the assertion Reed's fixture could not make when it was
// written: THE TWO READINGS NOW GIVE DIFFERENT ANSWERS, and the record says
// which one it is giving.
//
// Run from a checkout:  node --experimental-strip-types examples/coverage-provider-set-check.ts

import assert from "node:assert/strict";
import { advance, newCoverage, coverageCheck, startEpoch } from "../src/coverage.ts";

const first = { from: 100, to: 104 };
const second = { from: 105, to: 109 };
const AB = ["alpha", "beta"];
const BC = ["beta", "gamma"];

// ---------------------------------------------------------------------------
// Reed's original three checks, unchanged in substance.
// ---------------------------------------------------------------------------

let cov = newCoverage("synthetic", 100, AB);

const skipped = advance(cov, second, AB);
assert.equal(skipped.covered_through, 99); // existing hole guard works

cov = advance(cov, first, AB);
const missing = advance(cov, second, ["beta"]);
assert.equal(missing.covered_through, 104); // missing-provider guard works

const stable = advance(cov, second, AB);
assert.deepEqual(coverageCheck(stable, 109), {
  covered: true,
  through: 109,
  epoch: 0,
  required_set: ["alpha", "beta"],
});

// ---------------------------------------------------------------------------
// The contract question, and the answer it now gets.
// ---------------------------------------------------------------------------

// A caller changes the required provider set between adjacent ranges. Under the
// old code this cleared 100..109 outright. It now requires an explicit epoch,
// and the epoch starts unread.
const switched = advance(startEpoch(cov, BC), second, BC);
const switchedCheck = coverageCheck(switched, 109);
assert.equal(switchedCheck.covered, false, "beta+gamma has not read 100..104");
assert.equal(switchedCheck.covered === false && switchedCheck.reason, "coverage_gap");

// Reed's independent account of the same fact: the blocks gamma never read.
const observed = {
  alpha: new Set([100, 101, 102, 103, 104]),
  beta: new Set([100, 101, 102, 103, 104, 105, 106, 107, 108, 109]),
  gamma: new Set([105, 106, 107, 108, 109]),
};
const unreadByGamma = Array.from({ length: 10 }, (_, i) => i + 100)
  .filter((b) => !observed.gamma.has(b));
assert.deepEqual(unreadByGamma, [100, 101, 102, 103, 104]);

// THE ASSERTION THE ORIGINAL FIXTURE COULD NOT MAKE: the two readings are now
// different answers rather than one ambiguous one. Same record, same tip.
const weak = coverageCheck(stable, 109); // "whichever set was required at the time"
const strong = coverageCheck(stable, 109, BC); // "the set I am running now"
assert.equal(weak.covered, true);
assert.equal(strong.covered, false);
assert.equal(strong.covered === false && strong.reason, "required_set_changed");
assert.deepEqual(strong.covered === false && strong.asked_set, ["beta", "gamma"]);
assert.notDeepEqual(weak, strong, "one record, two questions, two answers");

// Zero required providers was a separate configuration precondition travelling
// in prose. It is local to the functions now.
assert.throws(() => newCoverage("empty", 100, []), /empty required set/);
assert.throws(() => advance(stable, { from: 110, to: 119 }, [], []), /empty required set/);

console.log(
  JSON.stringify(
    {
      hole_guard: "passed",
      missing_provider_guard: "passed",
      fixed_provider_control: coverageCheck(stable, 109),
      switched_provider_guard: switchedCheck,
      unreadByGamma,
      weak_reading: weak,
      strong_reading: strong,
      empty_provider_guard: "throws",
      interpretation:
        "The record identifies the set and epoch it certifies; a changed set starts a new epoch; the current-set question refuses rather than returning an interpretable true.",
    },
    null,
    2,
  ),
);
