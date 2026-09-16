// Guards for the public page renderer (issue #18).
//
// Each test names the mutation that kills it. The merge bar is that someone
// applied the mutation and watched it go red, not that the suite was green.

import test from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_TIER,
  evaluateWindow,
  parseLog,
  renderFirstLine,
  renderFullPageHtml,
  renderLogHtml,
  renderReadingHtml,
} from "../src/page.ts";
import type { Reading, ReadingContent } from "../src/reading.ts";
import type { Window } from "../src/commitment.ts";

function sampleReading(over: Partial<Reading> = {}): Reading {
  return {
    commitment: "c-lock-q1",
    verdict: "HELD",
    reason: "no outbound transfer seen in window; window open",
    rpc: [
      {
        provider: "base-official",
        method: "eth_getLogs",
        params: [{ fromBlock: "0x30f0e00", toBlock: "0x30f0e0a", address: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913" }],
        result: [],
        at_block: 51321789,
      },
      {
        provider: "publicnode",
        method: "eth_getLogs",
        params: [{ fromBlock: "0x30f0e00", toBlock: "0x30f0e0a", address: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913" }],
        result: [],
        at_block: 51321789,
      },
    ],
    read_at: 1_700_000_000_000,
    prev_hash: "0000000000000000000000000000000000000000000000000000000000000000",
    hash: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    sig: "sig_sample_base64url",
    key: "0xed25519_pubkey",
    ...over,
  };
}

test("parsing of JSONL readings into HTML elements", () => {
  // Killing mutation: drop JSON.parse or return empty readings. The parser
  // must turn raw published lines into structured Reading objects and render
  // semantic HTML cards.
  const r1 = sampleReading({ commitment: "c-1", verdict: "HELD" });
  const r2 = sampleReading({ commitment: "c-2", verdict: "UNREADABLE", rpc: [], note: "provider timeout" });
  const jsonl = `${JSON.stringify(r1)}\n${JSON.stringify(r2)}\n`;

  const { readings, rejected } = parseLog(jsonl);
  assert.equal(readings.length, 2);
  assert.equal(rejected.length, 0);
  assert.equal(readings[0]!.commitment, "c-1");
  assert.equal(readings[1]!.commitment, "c-2");

  const html = renderLogHtml(readings);
  assert.match(html, /class="reading-card reading-card-held"/);
  assert.match(html, /class="reading-card reading-card-unreadable"/);
  assert.match(html, /Commitment ID:.*c-1/);
  assert.match(html, /Commitment ID:.*c-2/);

  // A truncated final line must be rejected, not parsed into plausible data.
  const truncatedJsonl = `${JSON.stringify(r1)}\n{"commitment":"c-3","verdict":"HE`;
  const truncatedResult = parseLog(truncatedJsonl);
  assert.equal(truncatedResult.readings.length, 1);
  assert.equal(truncatedResult.rejected.length, 1);
  assert.match(truncatedResult.rejected[0]!.problem, /truncated final line/);
});

test("first line always shows verdict and Monitored tier (never enforced)", () => {
  // Killing mutation: change DEFAULT_TIER to Enforced, or omit Monitored.
  // The specification requires:
  // "The verdict, and the tier, in the first line. Monitored, never called enforced."
  // Calling a monitored position "locked" or "enforced" is the lie this project exists to end.
  const verdicts = ["HELD", "BROKEN", "UNREADABLE", "DEFAULTED"] as const;

  for (const v of verdicts) {
    const r = sampleReading({ verdict: v });
    const cardHtml = renderReadingHtml(r);

    // The first line container must be at the very top of header
    const firstLineMatch = cardHtml.match(/<div class="first-line">([\s\S]*?)<\/div>/);
    assert.ok(firstLineMatch, `missing .first-line block for ${v}`);
    const firstLineContent = firstLineMatch[1]!;

    // Must show the verdict and the tier in the first line
    assert.match(firstLineContent, new RegExp(`class="verdict verdict-${v.toLowerCase()}">${v}<\/span>`));
    assert.match(firstLineContent, /class="tier tier-monitored">Tier: Monitored<\/span>/);

    // Must NEVER contain "enforced" or "locked"
    assert.doesNotMatch(firstLineContent, /enforced/i);
    assert.doesNotMatch(firstLineContent, /locked/i);
  }

  // Attempting to label a monitored position as "enforced" or "locked" is explicitly refused
  assert.throws(() => renderFirstLine("HELD", "Enforced"), /never be called "Enforced"/);
  assert.throws(() => renderFirstLine("HELD", "contract-enforced"), /never be called/);
  assert.throws(() => renderFirstLine("HELD", "locked"), /never be called/);
});

test("UNREADABLE and DEFAULTED rendered as plainly as HELD (not hidden or quiet)", () => {
  // Killing mutation: add display: none, hidden, or drop callouts for bad states.
  // If the design makes the bad states quiet, the design is wrong: a reader
  // glancing at this page must not come away reassured by a reading nobody could take.
  const unreadable = sampleReading({
    verdict: "UNREADABLE",
    reason: "providers disagreed",
    note: "base-official returned 0x1, publicnode returned 0x2",
  });
  const defaulted = sampleReading({
    verdict: "DEFAULTED",
    reason: "outflow never disclosed within the window",
  });
  const held = sampleReading({
    verdict: "HELD",
    reason: "no outbound transfer seen in window",
  });

  const unreadableHtml = renderReadingHtml(unreadable);
  const defaultedHtml = renderReadingHtml(defaulted);
  const heldHtml = renderReadingHtml(held);

  // Neither must be hidden
  for (const html of [unreadableHtml, defaultedHtml, heldHtml]) {
    assert.doesNotMatch(html, /display:\s*none/i);
    assert.doesNotMatch(html, /\bhidden\b/);
  }

  // UNREADABLE and DEFAULTED must carry prominent role="alert" callouts
  assert.match(unreadableHtml, /<div class="verdict-callout callout-unreadable" role="alert">/);
  assert.match(unreadableHtml, /UNREADABLE:.*The chain could not be read/);
  assert.match(unreadableHtml, /base-official returned 0x1, publicnode returned 0x2/);

  assert.match(defaultedHtml, /<div class="verdict-callout callout-defaulted" role="alert">/);
  assert.match(defaultedHtml, /DEFAULTED:.*window closed or elapsed/);

  // First line badges must be rendered for both
  assert.match(unreadableHtml, /class="verdict verdict-unreadable">UNREADABLE<\/span>/);
  assert.match(defaultedHtml, /class="verdict verdict-defaulted">DEFAULTED<\/span>/);

  // Structural markup length: bad states must have equal or greater detail than HELD
  assert.ok(unreadableHtml.length >= heldHtml.length);
  assert.ok(defaultedHtml.length >= heldHtml.length);
});

test("RPC questions, params, pinned blocks, provider responses, and hash chain are included", () => {
  // Killing mutation: remove params, block, or hash chain. The published log
  // line carries everything a stranger needs to re-derive the verdict byte-for-byte;
  // the page is a rendering of it, not a second source.
  const r = sampleReading({
    hash: "3333333333333333333333333333333333333333333333333333333333333333",
    prev_hash: "2222222222222222222222222222222222222222222222222222222222222222",
    rpc: [
      {
        provider: "prov-a",
        method: "eth_call",
        params: [{ to: "0x123", data: "0xabc" }, "latest"],
        result: "0x000000000000000000000000000000000000000000000000000000000000000a",
        at_block: 99999,
      },
    ],
  });

  const html = renderReadingHtml(r);

  // Hash chain
  assert.match(html, /class="chain-hash prev-hash">2222222222222222222222222222222222222222222222222222222222222222<\/code>/);
  assert.match(html, /class="chain-hash current-hash">3333333333333333333333333333333333333333333333333333333333333333<\/code>/);
  assert.match(html, /chained by sha256/);

  // RPC method, provider, block, params, result
  assert.match(html, /class="rpc-provider">prov-a<\/strong>/);
  assert.match(html, /class="rpc-block">99999<\/code>/);
  assert.match(html, /class="rpc-method">eth_call<\/code>/);
  assert.match(html, /class="rpc-params"><code>[\s\S]*?&quot;to&quot;: &quot;0x123&quot;[\s\S]*?<\/code><\/pre>/);
  assert.match(html, /class="rpc-result"><code>[\s\S]*?&quot;0x000000000000000000000000000000000000000000000000000000000000000a&quot;[\s\S]*?<\/code><\/pre>/);
});

test("dynamic window evaluation based on timestamp T", () => {
  // Killing mutation: hardcode window status or ignore argument T.
  // evaluate.ts takes T as an argument for this exact reason: the page supplies
  // its own T and the answer is correct without anything having run in the background.
  const win: Window = {
    from: 1_700_000_000_000,
    to: 1_700_100_000_000,
  };

  const tBefore = 1_699_999_999_000;
  const tInside = 1_700_050_000_000;
  const tAfter = 1_700_100_000_000;

  const evalBefore = evaluateWindow(win, tBefore);
  assert.equal(evalBefore.status, "not_started");
  assert.equal(evalBefore.open, false);

  const evalInside = evaluateWindow(win, tInside);
  assert.equal(evalInside.status, "open");
  assert.equal(evalInside.open, true);

  const evalAfter = evaluateWindow(win, tAfter);
  assert.equal(evalAfter.status, "closed");
  assert.equal(evalAfter.open, false);

  // In HTML rendering:
  const r = sampleReading();
  const htmlBefore = renderReadingHtml(r, { window: win, T: tBefore });
  assert.match(htmlBefore, /window-evaluation-not_started/);
  assert.match(htmlBefore, /\(Open: <code>false<\/code>\)/);

  const htmlInside = renderReadingHtml(r, { window: win, T: tInside });
  assert.match(htmlInside, /window-evaluation-open/);
  assert.match(htmlInside, /\(Open: <code>true<\/code>\)/);

  const htmlAfter = renderReadingHtml(r, { window: win, T: tAfter });
  assert.match(htmlAfter, /window-evaluation-closed/);
  assert.match(htmlAfter, /\(Open: <code>false<\/code>\)/);
});

test("renderFullPageHtml outputs valid self-contained HTML document", () => {
  const r = sampleReading();
  const page = renderFullPageHtml([r], { T: 1_700_050_000_000, title: "Test Registry" });

  assert.match(page, /^<!DOCTYPE html>/);
  assert.match(page, /<title>Test Registry<\/title>/);
  assert.match(page, /<style>/);
  assert.match(page, /Render the log, never a second source of truth/);
  assert.match(page, /class="reading-card reading-card-held"/);
});
