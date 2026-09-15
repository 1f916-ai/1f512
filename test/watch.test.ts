// Guards for one watch cycle.
//
// The rule this file adds to the system: A CYCLE ALWAYS WRITES A LINE. A gap in
// the log must mean "nobody looked" and nothing else, so "we looked and could
// not see" has to leave a record.

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cycle, cycleAll, type CycleDeps } from "../src/watch.ts";
import { load } from "../src/log.ts";
import type { ChainState, Commitment, Transfer } from "../src/commitment.ts";

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
  return join(await mkdtemp(join(tmpdir(), "1f512-watch-")), "readings.jsonl");
}

const xfer = (over: Partial<Transfer> = {}): Transfer => ({
  tx: "0x" + "22".repeat(32), from: SUBJ, to: OTHER, token: TOKEN,
  value: "1", at_block: 101, at_time: FROM + 3_600_000, ...over,
});

function deps(logPath: string, over: Partial<CycleDeps> = {}): CycleDeps {
  return {
    logPath,
    block: async () => 500,
    now: () => FROM + 86_400_000,
    read: async () => ({
      method: "eth_getLogs",
      params: [{ fromBlock: "0x1" }],
      attempts: [
        { provider: "alpha", ok: true, result: [], at_block: 500 },
        { provider: "beta", ok: true, result: [], at_block: 500 },
      ],
    }),
    decode: (result, at_block, at_time): ChainState => ({
      at_block, at_time, balances: {}, transfers: (result as Transfer[]) ?? [],
    }),
    ...over,
  };
}

test("a clean cycle writes one HELD line carrying both providers", async () => {
  const p = await tmpLog();
  const r = await cycle(C, deps(p));
  assert.equal(r.line.verdict, "HELD");
  assert.equal(r.line.rpc.length, 2, "both exchanges published, not just the winner");
  const { lines } = await load(p);
  assert.equal(lines.length, 1);
});

test("A CYCLE THAT CANNOT SEE THE CHAIN STILL WRITES A LINE", async () => {
  // The rule this file exists for. A gap in the log must mean "nobody looked".
  // If an unreachable provider produced no line, a reader could not tell a
  // dead watcher from a watched thing that was fine.
  //
  // Killing mutation: return early without appending when deps.read throws.
  // This goes red, and the log develops silent holes that look like downtime.
  const p = await tmpLog();
  const r = await cycle(C, deps(p, { read: async () => { throw new Error("ECONNREFUSED"); } }));
  assert.equal(r.line.verdict, "UNREADABLE");
  assert.match(r.line.reason, /could not read the chain/);
  assert.equal((await load(p)).lines.length, 1, "the line exists");
});

test("a disagreement is UNREADABLE and keeps both answers", async () => {
  // Killing mutation: publish only the first attempt's exchange. The evidence
  // that they differed -- the thing that makes the verdict checkable -- is
  // destroyed at the moment it matters.
  const p = await tmpLog();
  const r = await cycle(C, deps(p, {
    read: async () => ({
      method: "eth_getLogs", params: [],
      attempts: [
        { provider: "alpha", ok: true, result: [xfer()], at_block: 500 },
        { provider: "beta", ok: true, result: [], at_block: 500 },
      ],
    }),
  }));
  assert.equal(r.line.verdict, "UNREADABLE");
  assert.equal(r.line.reason, "disagreed");
  assert.equal(r.line.rpc.length, 2, "both answers recorded");
});

test("one provider failing is UNREADABLE, and the error is written down", async () => {
  // Killing mutation: drop the note. The log then says UNREADABLE with no
  // indication of which provider failed or why, and nobody can fix it.
  const p = await tmpLog();
  const r = await cycle(C, deps(p, {
    read: async () => ({
      method: "eth_getLogs", params: [],
      attempts: [
        { provider: "alpha", ok: true, result: [], at_block: 500 },
        { provider: "beta", ok: false, error: "http 429" },
      ],
    }),
  }));
  assert.equal(r.line.verdict, "UNREADABLE");
  assert.equal(r.line.reason, "one_failed");
  assert.match(String(r.line.note), /beta: http 429/);
});

test("a break is written as BROKEN with the transfer as evidence", async () => {
  const p = await tmpLog();
  const bad = xfer();
  const r = await cycle(C, deps(p, {
    read: async () => ({
      method: "eth_getLogs", params: [],
      attempts: [
        { provider: "alpha", ok: true, result: [bad], at_block: 500 },
        { provider: "beta", ok: true, result: [bad], at_block: 500 },
      ],
    }),
  }));
  assert.equal(r.line.verdict, "BROKEN");
  assert.match(String(r.line.note), /0x2222/, "the evidence names the transaction");
});

test("successive cycles chain onto each other", async () => {
  const p = await tmpLog();
  const a = await cycle(C, deps(p));
  const b = await cycle(C, deps(p, { now: () => FROM + 2 * 86_400_000 }));
  assert.equal(b.line.prev_hash, a.line.hash);
});

test("T comes from deps, so a replay at the same T gives the same verdict", async () => {
  // The read-path clock only holds if the cycle does not sneak in a live clock.
  //
  // Killing mutation: use Date.now() for at_time in cycle(). read_at stops
  // matching the supplied T and a replay cannot reproduce the line.
  const p = await tmpLog();
  const T = FROM + 5 * 86_400_000;
  const r = await cycle(C, deps(p, { now: () => T }));
  assert.equal(r.line.read_at, T);
});

test("one failing commitment does not stop the others", async () => {
  // A registry that stops watching everything because one entry cannot be
  // written has turned a small problem into a blackout.
  //
  // Killing mutation: rethrow instead of collecting in cycleAll. This goes red.
  //
  // (The first version of this test used a commitment with an empty id and
  // assumed append() would reject it. It does not -- nothing failed, so the
  // test passed whether or not cycleAll recovered. That is the second vacuous
  // guard this project has caught by running the mutation rather than trusting
  // the comment. The failure here is now real: the writer refuses one id.)
  const p = await tmpLog();
  const d = deps(p, {
    write: async (path, data) => {
      if (data.includes('"c-poison"')) throw new Error("disk full");
      const { appendFile } = await import("node:fs/promises");
      await appendFile(path, data, "utf8");
    },
  });
  const { done, failed } = await cycleAll([C, { ...C, id: "c-poison" }, { ...C, id: "c-3" }], d);
  assert.equal(failed.length, 1, "the failing one is reported");
  assert.equal(failed[0]!.commitment, "c-poison");
  assert.match(failed[0]!.error, /disk full/);
  assert.equal(done.length, 2, "and the healthy ones still got their lines");
  assert.deepEqual(done.map((r) => r.commitment), ["c-1", "c-3"]);
});

test("the log verifies after a run of mixed verdicts", async () => {
  const p = await tmpLog();
  await cycle(C, deps(p));
  await cycle(C, deps(p, { now: () => FROM + 2 * 86_400_000, read: async () => { throw new Error("down"); } }));
  await cycle(C, deps(p, { now: () => FROM + 3 * 86_400_000 }));
  const { lines, rejected } = await load(p);
  assert.equal(rejected.length, 0);
  assert.equal(lines.length, 3);
  assert.deepEqual(lines.map((l) => l.verdict), ["HELD", "UNREADABLE", "HELD"]);
  const text = await readFile(p, "utf8");
  assert.ok(text.endsWith("\n"));
});
