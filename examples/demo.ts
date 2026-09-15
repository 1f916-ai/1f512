// A whole registry run, end to end, against a fake chain. No network, no keys.
//
//   npm run demo
//
// This exists because a library of pure functions is hard to believe. Run it and
// you get an actual append-only log on disk with four verdicts in it, and the
// verifier agreeing that it is intact -- then a tampered copy that it refuses.
//
// Everything here uses the same code paths a real deployment would; only the
// two RPC providers are fake, and they are fake in the interesting ways: one of
// them goes down, and later they disagree.

import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { file, type Commitment, type Transfer } from "../src/commitment.ts";
import { cycle, type CycleDeps } from "../src/watch.ts";
import { verify, load } from "../src/log.ts";
import type { Attempt } from "../src/agreement.ts";

const SUBJ = "0x" + "aa".repeat(20);
const TREASURY = "0x" + "cc".repeat(20);
const TOKEN = "0x" + "bb".repeat(20);
const DAY = 86_400_000;
const T0 = Date.UTC(2026, 0, 1);

function say(s: string) {
  console.log(s);
}

async function main() {
  const dir = await mkdtemp(join(tmpdir(), "1f512-demo-"));
  const logPath = join(dir, "readings.jsonl");

  // ---------------------------------------------------------------- filing
  say("\n1. FILING — a commitment must carry the state that would break it\n");

  const impossible: Commitment = {
    id: "bad-1",
    predicate: { kind: "balance-floor", subject: SUBJ, token: TOKEN, floor: "0" },
    window: { from: T0, to: T0 + 90 * DAY },
  };
  const refused = file(impossible);
  say(`   "hold at least 0 tokens" -> ${refused.filed ? "filed" : "REFUSED"}`);
  if (!refused.filed) say(`   ${refused.reason}\n`);

  const c: Commitment = {
    id: "no-dump-q1",
    predicate: { kind: "no-outbound-transfer", subject: SUBJ, token: TOKEN },
    window: { from: T0, to: T0 + 90 * DAY },
  };
  const filed = file(c);
  say(`   "no outbound transfers this quarter" -> ${filed.filed ? "FILED" : "refused"}`);
  if (filed.filed) {
    const w = filed.witness.transfers[0]!;
    say(`   published witness: a transfer of ${w.value} from ${w.from.slice(0, 10)}... would break it\n`);
  }

  // --------------------------------------------------------------- watching
  say("2. WATCHING — four cycles against a chain that misbehaves\n");

  let chainTransfers: Transfer[] = [];
  let mode: "ok" | "one-down" | "disagree" = "ok";

  const deps = (nowMs: number): CycleDeps => ({
    logPath,
    block: async () => 1_000 + Math.floor((nowMs - T0) / DAY),
    now: () => nowMs,
    read: async (): Promise<{ method: string; params: unknown[]; attempts: Attempt[] }> => {
      const at_block = 1_000 + Math.floor((nowMs - T0) / DAY);
      const alpha: Attempt = { provider: "alpha", ok: true, result: chainTransfers, at_block };
      if (mode === "one-down") {
        return { method: "eth_getLogs", params: [], attempts: [alpha, { provider: "beta", ok: false, error: "http 429" }] };
      }
      // A REAL disagreement: beta reports a transfer alpha cannot see. (The
      // first version of this demo had beta return [] while alpha also had [],
      // which is agreement -- the line printed HELD and the label lied.)
      const phantom: Transfer = {
        tx: "0x" + "99".repeat(32), from: SUBJ, to: TREASURY, token: TOKEN,
        value: "1", at_block, at_time: nowMs,
      };
      const betaResult = mode === "disagree" ? [...chainTransfers, phantom] : chainTransfers;
      return {
        method: "eth_getLogs",
        params: [{ address: TOKEN, fromBlock: "0x1" }],
        attempts: [alpha, { provider: "beta", ok: true, result: betaResult, at_block }],
      };
    },
    decode: (result, at_block, at_time) => ({
      at_block, at_time, balances: {}, transfers: (result as Transfer[]) ?? [],
    }),
  });

  const r1 = await cycle(c, deps(T0 + 1 * DAY));
  say(`   day  1  ${r1.line.verdict.padEnd(10)} ${r1.line.reason}`);

  mode = "one-down";
  const r2 = await cycle(c, deps(T0 + 2 * DAY));
  say(`   day  2  ${r2.line.verdict.padEnd(10)} ${r2.line.reason} — ${r2.line.note}`);

  mode = "disagree";
  const r3 = await cycle(c, deps(T0 + 3 * DAY));
  say(`   day  3  ${r3.line.verdict.padEnd(10)} ${r3.line.reason} (both answers kept)`);

  mode = "ok";
  chainTransfers = [{
    tx: "0x" + "de".repeat(32), from: SUBJ, to: TREASURY, token: TOKEN,
    value: "5000000000000000000000", at_block: 1_004, at_time: T0 + 4 * DAY,
  }];
  const r4 = await cycle(c, deps(T0 + 4 * DAY + 3_600_000));
  say(`   day  4  ${r4.line.verdict.padEnd(10)} ${r4.line.reason}`);
  say(`           evidence: ${r4.line.note?.slice(0, 96)}...\n`);

  // ----------------------------------------------------------- verification
  say("3. VERIFYING — the log a stranger checks\n");

  const v = await verify(logPath);
  const { lines } = await load(logPath);
  say(`   ${lines.length} lines, chain intact: ${v.ok}`);
  say(`   each line carries the RPC calls that produced it:`);
  say(`     ${JSON.stringify(lines[0]!.rpc[0]).slice(0, 96)}...\n`);

  const tamperedPath = join(dir, "tampered.jsonl");
  const raw = (await readFile(logPath, "utf8")).trim().split("\n");
  const edited = JSON.parse(raw[3]!);
  edited.verdict = "HELD";
  edited.reason = "nothing to see here";
  raw[3] = JSON.stringify(edited);
  await writeFile(tamperedPath, raw.join("\n") + "\n", "utf8");

  const tv = await verify(tamperedPath);
  say(`   now someone edits BROKEN to HELD in the finished log:`);
  say(`   chain intact: ${tv.ok}`);
  for (const p of tv.problems.slice(0, 2)) say(`     ${p.slice(0, 104)}`);

  say(`\n   log: ${logPath}\n`);
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
