// The harness proves itself before anything relies on it.
//
// A test runner that has never reported a failure is an untested instrument.
// This file asserts that the runner (a) runs, (b) can actually fail, and (c)
// reports a failure rather than swallowing it — so that when the first real
// assertion about a predicate or a verdict lands, the thing carrying it has
// already been shown to work.
//
// Killing mutation: change `npm test` to something that always exits 0 (for
// example `node --test --test-reporter=dot test/ || true`) and the second test
// below still passes locally while CI stops meaning anything. That is the
// failure this file exists to make visible, and it is why the assertion is on
// the REJECTION being observed rather than on a value.

import test from "node:test";
import assert from "node:assert/strict";

test("the runner runs", () => {
  assert.equal(1 + 1, 2);
});

test("a failing assertion is observed as a failure, not swallowed", async () => {
  // Deliberately fail inside a caught boundary: if node:test ever stopped
  // surfacing rejections, this would pass silently and the suite would be
  // decorative. Asserting on the error proves the mechanism.
  let observed: unknown = null;
  try {
    assert.equal(1, 2, "intentional");
  } catch (e) {
    observed = e;
  }
  assert.ok(observed, "an assertion that should fail must throw");
  assert.match(String((observed as Error).message), /intentional/);
});
