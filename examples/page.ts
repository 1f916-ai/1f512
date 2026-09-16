// Demonstrate the public page renderer against a published log.
//
//   npm run page
//
// Shows how a static host, a CI job, or a local viewer renders a published
// JSONL log into the public page format without recomputing verdicts server-side
// or querying an RPC.

import { readFile } from "node:fs/promises";
import { parseLog, renderFullPageHtml, evaluateWindow } from "../src/page.ts";
import { verifyChain } from "../src/reading.ts";

async function main() {
  console.log("\n1. READING THE PUBLISHED LOG (never a second source of truth)\n");
  const raw = await readFile("public/readings.jsonl", "utf8");
  const { readings, rejected } = parseLog(raw);

  console.log(`   read ${readings.length} reading(s) from public/readings.jsonl`);
  if (rejected.length > 0) {
    console.log(`   found ${rejected.length} rejected line(s):`);
    for (const r of rejected) {
      console.log(`     line ${r.lineNumber}: ${r.problem}`);
    }
  }

  console.log("\n2. VERIFYING THE HASH CHAIN INDEPENDENTLY\n");
  const problems = await verifyChain(readings);
  if (problems.length === 0) {
    console.log("   ✓ Hash chain intact byte-for-byte across all lines.");
  } else {
    console.log(`   ✗ ${problems.length} chain problem(s) detected:`);
    for (const p of problems) console.log(`     ${p.problem} at line ${p.index}: ${p.detail}`);
  }

  console.log("\n3. RENDERING STATIC HTML\n");
  const html = renderFullPageHtml(readings, {
    title: "1F512 — Commitments about crypto holdings",
    T: Date.now(),
  });

  console.log(`   rendered ${html.length} bytes of static HTML (ready for public static serving)`);

  console.log("\n4. FIRST-LINE INTEGRITY CHECK (per commitment)\n");
  for (const r of readings) {
    console.log(`   [${r.commitment}] -> Verdict: ${r.verdict.padEnd(10)} | Tier: Monitored (never called enforced)`);
  }
  console.log("");
}

main().catch((err) => {
  console.error("Failed:", err);
  process.exit(1);
});
