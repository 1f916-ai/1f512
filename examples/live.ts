// Run the registry against a REAL chain. This is the file that answers "does it
// actually work", and it takes its endpoints from the environment so no key is
// ever in the repository:
//
//   RPC1=<url> RPC2=<url> npm run live
//
// The two URLs must be DIFFERENT PROVIDERS. Two URLs from one vendor is
// single-sourcing with extra steps, and agreement.ts refuses it by label.
//
// WHAT THIS FOUND ON ITS FIRST REAL RUN, recorded because it is the point of
// the whole design: asked for a 2000-block range, one provider answered and the other
// returned 413. A naive monitor takes the answer it got and publishes HELD.
// This published UNREADABLE with `quicknode: http 413` and moved on, because
// one provider answering is not evidence.
//
// Free-tier log ranges differ wildly per vendor and are the real operational
// constraint. MEASURED, not read off anyone's documentation, and they will
// move: on their free tiers Alchemy answered a 10-block eth_getLogs and refused
// more, QuickNode about 5, dRPC timed out past a few hundred. A deployment that wants a
// useful cadence needs at least one paid endpoint, and the second source can
// stay free only if the range fits inside its ceiling.

import { file, type Commitment, type Transfer } from "../src/commitment.ts";
import { cycle, type CycleDeps } from "../src/watch.ts";
import { verify, load } from "../src/log.ts";
import { askBoth, type Provider } from "../src/rpc.ts";
import type { Attempt } from "../src/agreement.ts";

if (!process.env.RPC1 || !process.env.RPC2) {
  console.error("set RPC1 and RPC2 to two DIFFERENT providers, e.g.\n  RPC1=https://... RPC2=https://... npm run live");
  process.exit(2);
}
const URL1 = process.env.RPC1;
const URL2 = process.env.RPC2;
const A: Provider = { label: process.env.RPC1_LABEL ?? "provider-a", url: URL1 };
const B: Provider = { label: process.env.RPC2_LABEL ?? "provider-b", url: URL2 };

// How many blocks of logs to ask for. Ten is the range Alchemy's free tier
// answered for us before refusing more, so it is a default that clears the
// ceilings noted above rather than the smallest of them. Raise it when both
// endpoints can take it.
const BLOCKS = Number(process.env.BLOCKS ?? 10);
// USDC on Base, and the 1F916 escrow contract as a real subject with real history.
const USDC = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";
const SUBJ = "0xba4a96391ad34ed9733470bf203bd216b07b9b1b";
const logPath = process.env.LIVE_LOG ?? "./live-readings.jsonl";

const topic = (a: string) => "0x" + a.slice(2).padStart(64, "0");

async function height(): Promise<number> {
  const r = await askBoth([A, B], { method: "eth_blockNumber", params: [] }, 0);
  const ok = r.filter((x): x is Extract<Attempt, { ok: true }> => x.ok);
  if (ok.length < 2) throw new Error("could not agree a height: " + JSON.stringify(r));
  return Math.min(...ok.map((x) => parseInt(String(x.result), 16)));
}

async function main() {
  const tip = await height();
  const from = tip - (BLOCKS - 1);
  console.log(`block ${tip}, scanning the last ${BLOCKS} block(s) from ${A.label} and ${B.label}\n`);

  const c: Commitment = {
    id: "escrow-no-outbound-usdc",
    predicate: { kind: "no-outbound-transfer", subject: SUBJ, token: USDC },
    window: { from: Date.now() - 86_400_000, to: Date.now() + 86_400_000 },
  };
  const f = file(c);
  console.log(`filing: ${f.filed ? "FILED, witness published" : "refused"}`);

  const deps: CycleDeps = {
    logPath,
    block: async () => tip,
    now: () => Date.now(),
    read: async (_c, at_block) => {
      const params = [{
        fromBlock: "0x" + from.toString(16), toBlock: "0x" + tip.toString(16),
        address: USDC, topics: ["0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef", topic(SUBJ)],
      }];
      return { method: "eth_getLogs", params, attempts: await askBoth([A, B], { method: "eth_getLogs", params }, at_block) };
    },
    decode: (result, at_block, at_time) => ({
      at_block, at_time, balances: {},
      transfers: (result as { transactionHash: string; topics: string[]; data: string; blockNumber: string }[]).map((l): Transfer => ({
        tx: l.transactionHash,
        from: "0x" + l.topics[1]!.slice(26),
        to: "0x" + l.topics[2]!.slice(26),
        token: USDC,
        value: BigInt(l.data).toString(),
        at_block: parseInt(l.blockNumber, 16),
        at_time,
      })),
    }),
  };

  const r = await cycle(c, deps);
  console.log(`\nverdict: ${r.line.verdict}`);
  console.log(`reason:  ${r.line.reason}`);
  console.log(`providers that answered: ${r.line.rpc.map((x) => x.provider).join(", ")}`);
  console.log(`transfers seen: ${(r.line.rpc[0]?.result as unknown[])?.length ?? 0}`);
  if (r.line.note) console.log(`note: ${r.line.note.slice(0, 200)}`);

  const v = await verify(logPath);
  const { lines } = await load(logPath);
  console.log(`\nlog: ${lines.length} line(s), intact: ${v.ok}`);
  // THE CHECK THIS EXAMPLE EXISTS FOR. The endpoints carry API keys in their
  // paths. The log is append-only and meant to be published. So: assert that
  // nothing identifying either endpoint survived into the line -- not the key,
  // not the host. This is the property rpc.ts claims, checked against a real
  // provider's real error text rather than a fixture's.
  const published = JSON.stringify(lines[lines.length - 1]);
  const secrets: string[] = [];
  for (const u of [URL1, URL2]) {
    try {
      const parsed = new URL(u);
      secrets.push(parsed.host);
      for (const seg of parsed.pathname.split("/")) if (seg.length >= 16) secrets.push(seg);
    } catch {
      secrets.push(u);
    }
  }
  console.log(`\nDOES THE PUBLISHED LINE LEAK AN ENDPOINT?`);
  let leaked = false;
  for (const secret of secrets) {
    const hit = published.includes(secret);
    leaked ||= hit;
    console.log(`  ${secret.slice(0, 10)}${secret.length > 10 ? "..." : ""} : ${hit ? "LEAKED" : "absent"}`);
  }
  if (leaked) {
    console.error("\nFAIL: an endpoint reached the published log.");
    process.exitCode = 1;
  }
}

main().catch((e) => { console.error("FAILED:", String(e).slice(0, 300)); process.exitCode = 1; });
