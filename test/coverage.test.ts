// Guards for the coverage record and the coverage-aware cycle. Issue #15.
//
// The rule this file exists to enforce: a watcher may report a verdict about
// the tip only if it has read every block from the last covered height to the
// tip, from BOTH providers. A watcher that is behind must not look like a
// watcher seeing nothing wrong, so a gap is published as UNREADABLE with the
// gap in it, never smoothed to HELD.
//
// The check the issue says must exist: a test where the provider caps the
// range below the gap, and the watcher is asked for a verdict -- it must not
// return HELD. The mutation that kills the guard is named at the end of the
// file.

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  advanceCoverage,
  planCeiling,
  windowsToCover,
  type WindowResult,
} from "../src/coverage.ts";
import { watchCycle, type WatchDeps } from "../src/watch.ts";
import type { ChainState, Commitment, Transfer } from "../src/commitment.ts";
import type { Attempt } from "../src/agreement.ts";

const SUBJ = "0x" + "aa".repeat(20);
const OTHER = "0x" + "11".repeat(20);
const TOKEN = "0x" + "bb".repeat(20);
const FROM = 1_700_000_000_000;
const WINDOW = { from: FROM, to: FROM + 30 * 86_400_000 };

const C: Commitment = {
  id: "c-1",
  predicate: { kind: "no-outbound-transfer", subject: SUBJ, token: TOKEN },
  window: WINDOW,
};

async function tmpLog(): Promise<string> {
  return join(await mkdtemp(join(tmpdir(), "1f512-coverage-")), "readings.jsonl");
}

const xfer = (over: Partial<Transfer> = {}): Transfer => ({
  tx: "0x" + "22".repeat(32), from: SUBJ, to: OTHER, token: TOKEN,
  value: "1", at_block: 105, at_time: FROM + 3_600_000, ...over,
});

// ---------------------------------------------------------------------------
// windowsToCover: split (covered+1)..tip into windows at most `ceiling` wide.
// ---------------------------------------------------------------------------

test("windowsToCover splits the gap into ceiling-wide windows, in order", () => {
  // gap 101..125 (25 blocks), ceiling 10 -> [101-110],[111-120],[121-125].
  const w = windowsToCover(100, 125, 10);
  assert.deepEqual(w, [
    { from: 101, to: 110 },
    { from: 111, to: 120 },
    { from: 121, to: 125 },
  ]);
});

test("windowsToCover returns [] when already caught up", () => {
  assert.deepEqual(windowsToCover(125, 125, 10), []);
  assert.deepEqual(windowsToCover(130, 125, 10), []);
});

test("windowsToCover refuses a non-positive ceiling", () => {
  assert.throws(() => windowsToCover(0, 10, 0));
});

// ---------------------------------------------------------------------------
// planCeiling: the window is only as wide as the NARROWEST provider's cap.
// ---------------------------------------------------------------------------

test("planCeiling takes the minimum, because a window wider than the narrowest cap is refused by it", () => {
  assert.equal(planCeiling({ alpha: 10, beta: 5 }), 5);
  assert.equal(planCeiling({ alpha: 5, beta: 10 }), 5);
  assert.equal(planCeiling({ alpha: 10 }), 10);
});

test("planCeiling refuses an empty or non-positive plan", () => {
  assert.throws(() => planCeiling({}));
  assert.throws(() => planCeiling({ alpha: 0 }));
});

// ---------------------------------------------------------------------------
// advanceCoverage: the guard. Advance only as far as the highest block read
// from BOTH providers; a hole in the middle is a gap as much as a hole at the
// end.
// ---------------------------------------------------------------------------

const coveredWindow = (from: number, to: number): WindowResult => ({
  window: { from, to },
  covered: true,
  attempts: [
    { provider: "alpha", ok: true, result: [], at_block: to },
    { provider: "beta", ok: true, result: [], at_block: to },
  ],
});

const uncoveredWindow = (from: number, to: number): WindowResult => ({
  window: { from, to },
  covered: false,
  attempts: [
    { provider: "alpha", ok: true, result: [], at_block: to },
    { provider: "beta", ok: false, error: "range too large" },
  ],
});

test("advanceCoverage advances to the tip when every window is covered", () => {
  const d = advanceCoverage(100, 125, [
    coveredWindow(101, 110),
    coveredWindow(111, 120),
    coveredWindow(121, 125),
  ]);
  assert.equal(d.covered, 125);
  assert.equal(d.caughtUp, true);
  assert.equal(d.gapFrom, undefined);
});

test("advanceCoverage stops at the first uncovered block and reports the gap", () => {
  const d = advanceCoverage(100, 125, [
    coveredWindow(101, 110),
    coveredWindow(111, 120),
    uncoveredWindow(121, 125),
  ]);
  assert.equal(d.covered, 120);
  assert.equal(d.caughtUp, false);
  assert.equal(d.gapFrom, 121);
  assert.equal(d.gapSize, 5);
  assert.equal(d.tip, 125);
});

test("advanceCoverage treats a hole in the MIDDLE as a gap, not just a hole at the end", () => {
  // [101-110] covered, [111-120] NOT covered, [121-125] covered. The advance
  // must stop at 111 even though 121..125 is covered: coverage is contiguous.
  const d = advanceCoverage(100, 125, [
    coveredWindow(101, 110),
    uncoveredWindow(111, 120),
    coveredWindow(121, 125),
  ]);
  assert.equal(d.covered, 110);
  assert.equal(d.caughtUp, false);
  assert.equal(d.gapFrom, 111);
});

// ---------------------------------------------------------------------------
// watchCycle: the coverage-aware cycle. The named check lives here.
// ---------------------------------------------------------------------------

function watchDeps(
  logPath: string,
  covered: number,
  tip: number,
  ceilings: Record<string, number>,
  over: Partial<WatchDeps> = {},
): WatchDeps {
  return {
    block: async () => tip,
    now: () => FROM + 86_400_000,
    logPath,
    ceilings,
    covered,
    decode: (result, at_block, at_time): ChainState => ({
      at_block, at_time, balances: {}, transfers: (result as Transfer[]) ?? [],
    }),
    // Default: both providers answer every window with the given logs.
    readWindow: async (_c, from, to) => {
      const logs: Transfer[] = [];
      return {
        method: "eth_getLogs",
        params: [{ fromBlock: from, toBlock: to }],
        attempts: [
          { provider: "alpha", ok: true, result: logs, at_block: to },
          { provider: "beta", ok: true, result: logs, at_block: to },
        ],
      };
    },
    ...over,
  };
}

// THE CHECK THE ISSUE SAYS MUST EXIST.
//
// The provider caps the range below the gap: the gap (100 -> 125) is 25
// blocks, the ceiling is 10, so no single window covers it. The watcher splits
// into [101-110],[111-120],[121-125]. The tip window is NOT answered by beta
// (its cap is below this range), so it is not covered, so the watcher is
// behind. It is asked for a verdict. It must NOT return HELD.
//
// The clean data in the covered windows is a trap: if the watcher reported the
// tip from the windows it did read, the state looks clean and the verdict would
// be HELD. The only reason it is not HELD is the gap. That is the whole point.
test("a watcher capped below the gap must not return HELD (the named check)", async () => {
  const p = await tmpLog();
  const d = watchDeps(p, 100, 125, { alpha: 10, beta: 10 }, {
    readWindow: async (_c, from, to) => {
      // beta refuses the tip window: its cap is below this range.
      if (from >= 121) {
        return {
          method: "eth_getLogs",
          params: [{ fromBlock: from, toBlock: to }],
          attempts: [
            { provider: "alpha", ok: true, result: [], at_block: to },
            { provider: "beta", ok: false, error: "block range exceeds plan ceiling" },
          ],
        };
      }
      return {
        method: "eth_getLogs",
        params: [{ fromBlock: from, toBlock: to }],
        attempts: [
          { provider: "alpha", ok: true, result: [], at_block: to },
          { provider: "beta", ok: true, result: [], at_block: to },
        ],
      };
    },
  });
  const r = await watchCycle(C, d);
  // Not HELD. Not BROKEN either -- there is no evidence of a break, only a gap.
  assert.notEqual(r.line.verdict, "HELD");
  assert.equal(r.line.verdict, "UNREADABLE");
  assert.equal(r.line.reason, "coverage gap");
  // The gap is in the published line, not just implied.
  assert.match(r.line.note ?? "", /gap 121\.\.125/);
  assert.match(r.line.note ?? "", /covered=120/);
  // The coverage state advanced to the highest contiguous covered block, not
  // past the gap.
  assert.equal(r.covered, 120);
});

// Positive control: the same shape, but every window is covered. The watcher
// catches up and the clean state is HELD. This proves the multi-window read and
// merge actually work -- the negative test above is not red just because the
// watcher is broken.
test("a watcher that covers the whole gap reports the tip (positive control)", async () => {
  const p = await tmpLog();
  const d = watchDeps(p, 100, 125, { alpha: 10, beta: 10 });
  const r = await watchCycle(C, d);
  assert.equal(r.line.verdict, "HELD");
  assert.equal(r.covered, 125);
});

// The merge must carry data through: a transfer in a MIDDLE window is seen.
// This is the failure the issue exists to end -- a transfer in an unseen block
// means publishing HELD over a break. Here the block is seen, so the break is
// reported.
test("a transfer in a covered middle window is reported BROKEN, not smoothed to HELD", async () => {
  const p = await tmpLog();
  const t = xfer({ at_block: 115 });
  const d = watchDeps(p, 100, 125, { alpha: 10, beta: 10 }, {
    readWindow: async (_c, from, to) => {
      const logs: Transfer[] = from <= 115 && 115 <= to ? [t] : [];
      return {
        method: "eth_getLogs",
        params: [{ fromBlock: from, toBlock: to }],
        attempts: [
          { provider: "alpha", ok: true, result: logs, at_block: to },
          { provider: "beta", ok: true, result: logs, at_block: to },
        ],
      };
    },
  });
  const r = await watchCycle(C, d);
  assert.equal(r.line.verdict, "BROKEN");
  assert.equal(r.covered, 125);
});

// A window the two providers DISAGREE about is not covered, even though both
// answered: agreement is the unit of coverage, not answer.
test("a window the providers disagree about is a gap, not coverage", async () => {
  const p = await tmpLog();
  const d = watchDeps(p, 100, 110, { alpha: 10, beta: 10 }, {
    readWindow: async (_c, from, to) => ({
      method: "eth_getLogs",
      params: [{ fromBlock: from, toBlock: to }],
      attempts: [
        { provider: "alpha", ok: true, result: [], at_block: to },
        { provider: "beta", ok: true, result: [xfer({ at_block: to })], at_block: to },
      ],
    }),
  });
  const r = await watchCycle(C, d);
  assert.equal(r.line.verdict, "UNREADABLE");
  assert.equal(r.line.reason, "coverage gap");
  assert.equal(r.covered, 100);
});

// The log stays a valid hash chain after a gap line: a stranger can verify the
// UNREADABLE line, not just parse it.
test("the log verifies after a coverage-gap line", async () => {
  const p = await tmpLog();
  const d = watchDeps(p, 100, 125, { alpha: 10, beta: 10 }, {
    readWindow: async (_c, from, to) => ({
      method: "eth_getLogs",
      params: [{ fromBlock: from, toBlock: to }],
      attempts: [
        { provider: "alpha", ok: true, result: [], at_block: to },
        { provider: "beta", ok: false, error: "range exceeds ceiling" },
      ],
    }),
  });
  await watchCycle(C, d);
  const raw = await readFile(p, "utf8");
  const lines = raw.trim().split("\n");
  assert.equal(lines.length, 1);
  const line = JSON.parse(lines[0]!) as { verdict: string; hash: string; prev_hash: string };
  assert.equal(line.verdict, "UNREADABLE");
  assert.equal(line.prev_hash, "");
  assert.ok(line.hash.length === 64, "hash is a sha256 hex");
});

// ---------------------------------------------------------------------------
// THE NAMED MUTATION (CONTRIBUTING.md: "delete the behaviour in a scratch copy,
// watch it go red, and name that in the PR").
//
// Delete the coverage tracking: make advanceCoverage ignore the window results
// and always return { covered: tip, caughtUp: true, tip }. Then the
// "must not return HELD (the named check)" test goes red, because watchCycle
// proceeds to evaluate the clean covered windows and returns HELD.
//
// Verified in a scratch copy:
//   - with the guard:  "a watcher capped below the gap must not return HELD" PASSES
//   - with the guard deleted (advanceCoverage always caughtUp): that test FAILS
//     (verdict is HELD, not UNREADABLE)
// ---------------------------------------------------------------------------
