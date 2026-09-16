// The public page renderer: render the log, never a second source of truth.
//
// Issue #18: The project's claim is that a stranger can recompute a verdict
// instead of trusting it, and that claim is only true if a stranger can reach
// the inputs. Today they have to clone the repo.
//
// What it must show:
//   1. The verdict and the tier in the first line. Monitored, never called enforced.
//   2. The reading that produced it: RPC method, params, pinned block, result
//      from each provider, and the hash chain to the line before it.
//   3. UNREADABLE and DEFAULTED rendered as plainly as HELD. If bad states are
//      quiet, the design is wrong.
//   4. The window, and whether it is open at load time (evaluated at timestamp T).
//
// What it must NOT do:
//   - Recompute verdicts server-side and publish those. It renders the log.
//   - Require a wallet, a login, or a token to read.

import type { Commitment, Window } from "./commitment.ts";
import { canonical, preimage, type Reading, type ReadingContent, type RpcExchange, type Verdict, VERDICTS } from "./reading.ts";

export type Tier = "Monitored";
export const DEFAULT_TIER: Tier = "Monitored";

export interface WindowEvaluation {
  status: "not_started" | "open" | "closed";
  open: boolean;
  from: number;
  to: number;
  T: number;
  summary: string;
}

export interface RejectedLine {
  lineNumber: number;
  raw: string;
  problem: string;
}

export interface ParseLogResult {
  readings: Reading[];
  rejected: RejectedLine[];
}

export interface RenderOptions {
  tier?: Tier;
  window?: Window;
  T?: number;
  commitment?: Commitment;
}

export interface PageOptions {
  tier?: Tier;
  commitments?: Record<string, Commitment> | Commitment[];
  windows?: Record<string, Window>;
  T?: number;
  title?: string;
}

export interface FullPageOptions extends PageOptions {
  includeStyles?: boolean;
}

/**
 * Escape HTML special characters to prevent XSS when rendering arbitrary inputs.
 */
export function escapeHtml(str: unknown): string {
  if (str === null || str === undefined) return "";
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * Parse raw JSONL log text into Reading records.
 *
 * Catches truncated trailing lines and unparseable rows without silently
 * dropping them, matching log.ts behaviour in a browser-safe, pure function.
 */
export function parseLog(text: string): ParseLogResult {
  const readings: Reading[] = [];
  const rejected: RejectedLine[] = [];
  if (!text || text.trim() === "") return { readings, rejected };

  const parts = text.split("\n");
  const trailing = parts.pop();
  if (trailing !== "") {
    rejected.push({
      lineNumber: parts.length + 1,
      raw: (trailing ?? "").slice(0, 200),
      problem: "truncated final line: the append did not complete",
    });
  }

  parts.forEach((raw, i) => {
    if (raw === "") return;
    try {
      readings.push(JSON.parse(raw) as Reading);
    } catch (e) {
      rejected.push({
        lineNumber: i + 1,
        raw: raw.slice(0, 200),
        problem: `unparseable: ${String(e).slice(0, 120)}`,
      });
    }
  });

  return { readings, rejected };
}

/**
 * Evaluate whether a commitment window is open, closed, or not yet started at time T.
 *
 * evaluate.ts takes T as an argument for this exact reason: the page supplies
 * its own T and the answer is correct without anything running in the background.
 */
export function evaluateWindow(window: Window, T: number = Date.now()): WindowEvaluation {
  if (!Number.isSafeInteger(window.from) || !Number.isSafeInteger(window.to) || window.to <= window.from) {
    return {
      status: "closed",
      open: false,
      from: window.from,
      to: window.to,
      T,
      summary: "invalid window bounds",
    };
  }

  const open = T >= window.from && T < window.to;
  let status: WindowEvaluation["status"];
  let summary: string;

  if (T < window.from) {
    status = "not_started";
    summary = `window not yet open (starts ${new Date(window.from).toISOString()})`;
  } else if (T >= window.to) {
    status = "closed";
    summary = `window closed (ended ${new Date(window.to).toISOString()})`;
  } else {
    status = "open";
    summary = `window is open (active until ${new Date(window.to).toISOString()})`;
  }

  return { status, open, from: window.from, to: window.to, T, summary };
}

/**
 * Format the first line for a reading view.
 *
 * "The verdict, and the tier, in the first line. Monitored, never called enforced."
 * Calling a monitored position "locked" or "enforced" is the lie this project exists to end.
 */
export function renderFirstLine(verdict: Verdict, tier: string = DEFAULT_TIER): string {
  const norm = tier.trim().toLowerCase();
  if (norm.includes("enforced") || norm.includes("locked")) {
    throw new Error(
      `a monitored position must never be called "${tier}": calling a monitored position "locked" or "enforced" is the lie this registry exists to end`,
    );
  }
  if (!VERDICTS.includes(verdict)) {
    throw new Error(`unknown verdict ${verdict}`);
  }

  return [
    `<div class="first-line">`,
    `  <span class="verdict verdict-${verdict.toLowerCase()}">${escapeHtml(verdict)}</span>`,
    `  <span class="tier tier-monitored">Tier: Monitored</span>`,
    `</div>`,
  ].join("\n");
}

/**
 * Render one reading record into an HTML card.
 *
 * Contains:
 * - First line: Verdict + Tier (Monitored, never called enforced).
 * - Commitment identifier and reading timestamp.
 * - Callout notice for bad states (UNREADABLE and DEFAULTED given equal or prominent weight).
 * - Dynamic window evaluation if window information is provided or inferred.
 * - Hash chain linkage: prev_hash -> hash (and signature/key if present).
 * - Complete RPC inputs: provider label, pinned block, method, params, and result.
 */
export function renderReadingHtml(reading: Reading, options: RenderOptions = {}): string {
  const verdict = reading.verdict;
  const tier = options.tier ?? DEFAULT_TIER;
  const firstLine = renderFirstLine(verdict, tier);
  const readDate = new Date(reading.read_at).toISOString();

  // Window evaluation if window provided
  const win = options.window ?? options.commitment?.window;
  const T = options.T ?? Date.now();
  const winEval = win ? evaluateWindow(win, T) : null;

  // Prominent callouts for states: UNREADABLE and DEFAULTED are rendered as plainly as HELD
  let calloutHtml = "";
  if (verdict === "UNREADABLE") {
    calloutHtml = [
      `  <div class="verdict-callout callout-unreadable" role="alert">`,
      `    <strong class="callout-badge">UNREADABLE:</strong> The chain could not be read reliably or providers disagreed. This is a first-class verdict, never smoothed to HELD.`,
      reading.note ? `    <div class="callout-note">Note: <code>${escapeHtml(reading.note)}</code></div>` : "",
      `  </div>`,
    ].filter(Boolean).join("\n");
  } else if (verdict === "DEFAULTED") {
    calloutHtml = [
      `  <div class="verdict-callout callout-defaulted" role="alert">`,
      `    <strong class="callout-badge">DEFAULTED:</strong> The commitment window closed or elapsed without required disclosures or actions. Silence from the watcher is never reassurance.`,
      reading.note ? `    <div class="callout-note">Note: <code>${escapeHtml(reading.note)}</code></div>` : "",
      `  </div>`,
    ].filter(Boolean).join("\n");
  } else if (verdict === "BROKEN") {
    calloutHtml = [
      `  <div class="verdict-callout callout-broken" role="alert">`,
      `    <strong class="callout-badge">BROKEN:</strong> Chain state observed during this reading broke the commitment predicate.`,
      reading.note ? `    <div class="callout-note">Note: <code>${escapeHtml(reading.note)}</code></div>` : "",
      `  </div>`,
    ].filter(Boolean).join("\n");
  } else if (verdict === "HELD") {
    calloutHtml = [
      `  <div class="verdict-callout callout-held">`,
      `    <strong class="callout-badge">HELD:</strong> Chain state verified against the commitment predicate at this reading.`,
      `  </div>`,
    ].join("\n");
  }

  // Window section HTML
  let windowHtml = "";
  if (winEval) {
    windowHtml = [
      `  <section class="section-window">`,
      `    <h4 class="section-subtitle">Commitment Window</h4>`,
      `    <div class="window-evaluation window-evaluation-${winEval.status}">`,
      `      <div class="window-status-row">`,
      `        <span class="window-indicator window-indicator-${winEval.status}"></span>`,
      `        <span class="window-status-text">Status at T (${new Date(winEval.T).toISOString()}): <strong>${escapeHtml(winEval.summary)}</strong></span>`,
      `        <span class="window-open-flag">(Open: <code>${winEval.open}</code>)</span>`,
      `      </div>`,
      `      <div class="window-bounds-row">`,
      `        <span class="meta-label">Interval:</span>`,
      `        <code class="window-bound">${new Date(winEval.from).toISOString()}</code> (${winEval.from})`,
      `        <span class="bound-sep">&rarr;</span>`,
      `        <code class="window-bound">${new Date(winEval.to).toISOString()}</code> (${winEval.to})`,
      `      </div>`,
      `    </div>`,
      `  </section>`,
    ].join("\n");
  } else {
    // Inferred window note from reading reason
    const isWindowOpen = reading.reason.includes("window open");
    const isWindowClosed = reading.reason.includes("window closed");
    if (isWindowOpen || isWindowClosed) {
      windowHtml = [
        `  <section class="section-window section-window-inferred">`,
        `    <h4 class="section-subtitle">Commitment Window (from reading log)</h4>`,
        `    <div class="window-evaluation window-evaluation-${isWindowOpen ? "open" : "closed"}">`,
        `      <div class="window-status-row">`,
        `        <span class="window-indicator window-indicator-${isWindowOpen ? "open" : "closed"}"></span>`,
        `        <span class="window-status-text">Reading reason records: <strong>${escapeHtml(reading.reason)}</strong></span>`,
        `        <span class="window-open-flag">(Open: <code>${isWindowOpen}</code>)</span>`,
        `      </div>`,
        `    </div>`,
        `  </section>`,
      ].join("\n");
    }
  }

  // Hash chain HTML
  const hashChainHtml = [
    `  <section class="section-chain">`,
    `    <h4 class="section-subtitle">Hash Chain (append-only proof)</h4>`,
    `    <div class="chain-box">`,
    `      <div class="chain-step">`,
    `        <span class="meta-label">Previous Line Hash:</span>`,
    `        <code class="chain-hash prev-hash">${escapeHtml(reading.prev_hash || "(genesis)")}</code>`,
    `      </div>`,
    `      <div class="chain-link-arrow">&darr; <span>chained by sha256</span></div>`,
    `      <div class="chain-step">`,
    `        <span class="meta-label">Current Line Hash:</span>`,
    `        <code class="chain-hash current-hash">${escapeHtml(reading.hash)}</code>`,
    `      </div>`,
    reading.sig ? [
      `      <div class="chain-step chain-step-sig">`,
      `        <span class="meta-label">Signature:</span>`,
      `        <code class="chain-sig">${escapeHtml(reading.sig)}</code>`,
      reading.key ? `        <span class="chain-key">(Key: <code>${escapeHtml(reading.key)}</code>)</span>` : "",
      `      </div>`,
    ].filter(Boolean).join("\n") : "",
    `    </div>`,
    `  </section>`,
  ].filter(Boolean).join("\n");

  // RPC Exchanges HTML
  let rpcHtml = "";
  if (reading.rpc && reading.rpc.length > 0) {
    const exchangeCards = reading.rpc.map((exchange) => {
      return [
        `      <div class="rpc-exchange-card" data-provider="${escapeHtml(exchange.provider)}">`,
        `        <div class="rpc-exchange-header">`,
        `          <div class="rpc-provider-box">`,
        `            <span class="meta-label">Provider:</span>`,
        `            <strong class="rpc-provider">${escapeHtml(exchange.provider)}</strong>`,
        `          </div>`,
        `          <div class="rpc-block-box">`,
        `            <span class="meta-label">Pinned Block:</span>`,
        `            <code class="rpc-block">${escapeHtml(String(exchange.at_block))}</code>`,
        `          </div>`,
        `        </div>`,
        `        <div class="rpc-method-row">`,
        `          <span class="meta-label">RPC Method:</span>`,
        `          <code class="rpc-method">${escapeHtml(exchange.method)}</code>`,
        `        </div>`,
        `        <div class="rpc-detail-row">`,
        `          <div class="rpc-label-title">Params:</div>`,
        `          <pre class="rpc-params"><code>${escapeHtml(JSON.stringify(exchange.params, null, 2))}</code></pre>`,
        `        </div>`,
        `        <div class="rpc-detail-row">`,
        `          <div class="rpc-label-title">Result:</div>`,
        `          <pre class="rpc-result"><code>${escapeHtml(JSON.stringify(exchange.result, null, 2))}</code></pre>`,
        `        </div>`,
        `      </div>`,
      ].join("\n");
    }).join("\n");

    rpcHtml = [
      `  <section class="section-rpc">`,
      `    <h4 class="section-subtitle">RPC Reading Inputs (${reading.rpc.length} provider${reading.rpc.length === 1 ? "" : "s"})</h4>`,
      `    <div class="rpc-cards-grid">`,
      exchangeCards,
      `    </div>`,
      `  </section>`,
    ].join("\n");
  } else {
    rpcHtml = [
      `  <section class="section-rpc section-rpc-empty">`,
      `    <h4 class="section-subtitle">RPC Reading Inputs (0 providers)</h4>`,
      `    <div class="rpc-empty-notice">`,
      `      <em>No RPC provider responses recorded. Providers were unreachable or failed before response.</em>`,
      reading.note ? `      <div class="rpc-error-detail">Error: <code>${escapeHtml(reading.note)}</code></div>` : "",
      `    </div>`,
      `  </section>`,
    ].join("\n");
  }

  return [
    `<article class="reading-card reading-card-${verdict.toLowerCase()}" data-verdict="${escapeHtml(verdict)}" data-commitment="${escapeHtml(reading.commitment)}">`,
    `  <header class="reading-card-header">`,
    firstLine,
    `    <div class="reading-meta">`,
    `      <div class="meta-row"><span class="meta-label">Commitment ID:</span> <code class="commitment-id">${escapeHtml(reading.commitment)}</code></div>`,
    `      <div class="meta-row"><span class="meta-label">Read At:</span> <time class="read-at" datetime="${readDate}">${readDate} (${reading.read_at})</time></div>`,
    `      <div class="meta-row"><span class="meta-label">Reason:</span> <span class="verdict-reason">${escapeHtml(reading.reason)}</span></div>`,
    `    </div>`,
    `  </header>`,
    calloutHtml,
    windowHtml,
    hashChainHtml,
    rpcHtml,
    `</article>`,
  ].filter(Boolean).join("\n");
}

/**
 * Render a sequence of readings into an HTML list.
 */
export function renderLogHtml(readings: Reading[], options: PageOptions = {}): string {
  if (readings.length === 0) {
    return [
      `<div class="empty-log-notice">`,
      `  <h3>Log is empty</h3>`,
      `  <p>No readings recorded yet. A missing or empty log is an empty registry, not an error.</p>`,
      `</div>`,
    ].join("\n");
  }

  const commitmentsMap = new Map<string, Commitment>();
  if (options.commitments) {
    if (Array.isArray(options.commitments)) {
      for (const c of options.commitments) commitmentsMap.set(c.id, c);
    } else {
      for (const [id, c] of Object.entries(options.commitments)) commitmentsMap.set(id, c);
    }
  }

  const cards = readings.map((r) => {
    const c = commitmentsMap.get(r.commitment);
    const win = options.windows?.[r.commitment] ?? c?.window;
    return renderReadingHtml(r, {
      tier: options.tier ?? DEFAULT_TIER,
      window: win,
      commitment: c,
      T: options.T,
    });
  });

  return [
    `<div class="readings-container">`,
    cards.join("\n\n"),
    `</div>`,
  ].join("\n");
}

/**
 * Self-contained, zero-dependency CSS stylesheet.
 *
 * Clean, high-contrast, understated typography.
 * UNREADABLE and DEFAULTED have equal structural and visual weight as HELD.
 */
export const DEFAULT_STYLES = `
:root {
  --bg: #0f1115;
  --surface: #181b20;
  --surface-border: #2c323b;
  --text: #e2e8f0;
  --text-muted: #94a3b8;
  --code-bg: #1e2229;
  --code-border: #333a46;
  --accent: #3b82f6;

  /* Verdict palette: bold, high-contrast, unmuted */
  --verdict-held-bg: #064e3b;
  --verdict-held-border: #059669;
  --verdict-held-text: #ecfdf5;

  --verdict-broken-bg: #7f1d1d;
  --verdict-broken-border: #dc2626;
  --verdict-broken-text: #fef2f2;

  --verdict-unreadable-bg: #78350f;
  --verdict-unreadable-border: #d97706;
  --verdict-unreadable-text: #fffbeb;

  --verdict-defaulted-bg: #581c87;
  --verdict-defaulted-border: #9333ea;
  --verdict-defaulted-text: #faf5ff;

  --tier-bg: #1e293b;
  --tier-border: #475569;
  --tier-text: #cbd5e1;
}

* { box-sizing: border-box; margin: 0; padding: 0; }

body {
  background: var(--bg);
  color: var(--text);
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace;
  line-height: 1.5;
  padding: 2rem 1rem;
}

.page-wrapper {
  max-width: 1040px;
  margin: 0 auto;
}

.page-header {
  border-bottom: 2px solid var(--surface-border);
  padding-bottom: 1.5rem;
  margin-bottom: 2rem;
}

.page-header h1 {
  font-size: 1.75rem;
  font-weight: 700;
  letter-spacing: -0.02em;
  color: #fff;
  margin-bottom: 0.5rem;
}

.page-header .subtitle {
  color: var(--text-muted);
  font-size: 0.95rem;
  margin-bottom: 0.75rem;
}

.philosophy-banner {
  background: var(--surface);
  border: 1px solid var(--surface-border);
  border-left: 4px solid var(--accent);
  padding: 0.75rem 1rem;
  font-size: 0.85rem;
  color: var(--text);
}

.philosophy-banner p { margin: 0.25rem 0; }
.philosophy-banner strong { color: #fff; }

.readings-container {
  display: flex;
  flex-direction: column;
  gap: 2rem;
}

.reading-card {
  background: var(--surface);
  border: 2px solid var(--surface-border);
  border-radius: 4px;
  padding: 1.5rem;
  box-shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.2);
}

.reading-card-held { border-color: var(--verdict-held-border); }
.reading-card-broken { border-color: var(--verdict-broken-border); }
.reading-card-unreadable { border-color: var(--verdict-unreadable-border); }
.reading-card-defaulted { border-color: var(--verdict-defaulted-border); }

/* The First Line: Verdict and Tier, Monitored, never called enforced */
.first-line {
  display: flex;
  align-items: center;
  gap: 1rem;
  margin-bottom: 1rem;
  flex-wrap: wrap;
}

.verdict {
  font-size: 1.5rem;
  font-weight: 800;
  letter-spacing: 0.05em;
  padding: 0.25rem 0.85rem;
  border-radius: 4px;
  border: 2px solid;
  text-transform: uppercase;
}

.verdict-held {
  background: var(--verdict-held-bg);
  border-color: var(--verdict-held-border);
  color: var(--verdict-held-text);
}

.verdict-broken {
  background: var(--verdict-broken-bg);
  border-color: var(--verdict-broken-border);
  color: var(--verdict-broken-text);
}

.verdict-unreadable {
  background: var(--verdict-unreadable-bg);
  border-color: var(--verdict-unreadable-border);
  color: var(--verdict-unreadable-text);
}

.verdict-defaulted {
  background: var(--verdict-defaulted-bg);
  border-color: var(--verdict-defaulted-border);
  color: var(--verdict-defaulted-text);
}

.tier {
  font-size: 0.9rem;
  font-weight: 700;
  padding: 0.35rem 0.75rem;
  border-radius: 4px;
  background: var(--tier-bg);
  border: 1px solid var(--tier-border);
  color: var(--tier-text);
  letter-spacing: 0.03em;
}

.reading-meta {
  font-size: 0.88rem;
  display: flex;
  flex-direction: column;
  gap: 0.35rem;
  margin-bottom: 1rem;
  border-bottom: 1px solid var(--surface-border);
  padding-bottom: 1rem;
}

.meta-row { display: flex; gap: 0.5rem; flex-wrap: wrap; }
.meta-label { color: var(--text-muted); }

/* Verdict Callouts: equal prominent weight for bad states */
.verdict-callout {
  padding: 0.85rem 1rem;
  border-radius: 4px;
  margin-bottom: 1.25rem;
  font-size: 0.9rem;
  border-left: 4px solid;
}

.callout-held {
  background: #064e3b33;
  border-color: var(--verdict-held-border);
  color: var(--verdict-held-text);
}

.callout-broken {
  background: #7f1d1d33;
  border-color: var(--verdict-broken-border);
  color: var(--verdict-broken-text);
}

.callout-unreadable {
  background: #78350f33;
  border-color: var(--verdict-unreadable-border);
  color: var(--verdict-unreadable-text);
}

.callout-defaulted {
  background: #581c8733;
  border-color: var(--verdict-defaulted-border);
  color: var(--verdict-defaulted-text);
}

.callout-badge { text-transform: uppercase; margin-right: 0.4rem; }
.callout-note { margin-top: 0.5rem; font-size: 0.85rem; }

/* Window Section */
.section-window {
  margin-bottom: 1.5rem;
  border-bottom: 1px solid var(--surface-border);
  padding-bottom: 1rem;
}

.section-subtitle {
  font-size: 0.85rem;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  color: var(--text-muted);
  margin-bottom: 0.5rem;
}

.window-evaluation {
  background: var(--code-bg);
  border: 1px solid var(--code-border);
  border-radius: 4px;
  padding: 0.75rem 1rem;
  font-size: 0.85rem;
}

.window-status-row {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  margin-bottom: 0.4rem;
  flex-wrap: wrap;
}

.window-indicator {
  width: 10px;
  height: 10px;
  border-radius: 50%;
  display: inline-block;
}

.window-indicator-open { background: #10b981; box-shadow: 0 0 6px #10b981; }
.window-indicator-closed { background: #94a3b8; }
.window-indicator-not_started { background: #f59e0b; }

.window-bounds-row {
  color: var(--text-muted);
  font-size: 0.8rem;
}

/* Hash Chain Section */
.section-chain {
  margin-bottom: 1.5rem;
  border-bottom: 1px solid var(--surface-border);
  padding-bottom: 1rem;
}

.chain-box {
  background: var(--code-bg);
  border: 1px solid var(--code-border);
  border-radius: 4px;
  padding: 0.75rem 1rem;
  font-size: 0.85rem;
  display: flex;
  flex-direction: column;
  gap: 0.4rem;
}

.chain-step {
  display: flex;
  gap: 0.5rem;
  align-items: baseline;
  flex-wrap: wrap;
}

.chain-link-arrow {
  color: var(--text-muted);
  font-size: 0.8rem;
  padding-left: 1rem;
}

.chain-hash, .chain-sig {
  font-family: inherit;
  color: #67e8f9;
  word-break: break-all;
}

/* RPC Reading Inputs Section */
.section-rpc {
  margin-top: 1rem;
}

.rpc-cards-grid {
  display: grid;
  grid-template-columns: 1fr;
  gap: 1rem;
}

@media (min-width: 768px) {
  .rpc-cards-grid {
    grid-template-columns: repeat(auto-fit, minmax(420px, 1fr));
  }
}

.rpc-exchange-card {
  background: var(--code-bg);
  border: 1px solid var(--code-border);
  border-radius: 4px;
  padding: 1rem;
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
}

.rpc-exchange-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  border-bottom: 1px solid var(--code-border);
  padding-bottom: 0.5rem;
  flex-wrap: wrap;
  gap: 0.5rem;
}

.rpc-provider { color: #facc15; font-size: 0.95rem; }
.rpc-block { color: #38bdf8; font-weight: 700; }
.rpc-method { color: #a78bfa; font-weight: 700; }

.rpc-label-title {
  font-size: 0.78rem;
  color: var(--text-muted);
  text-transform: uppercase;
  margin-bottom: 0.25rem;
}

pre.rpc-params, pre.rpc-result {
  background: #111418;
  border: 1px solid #232832;
  border-radius: 3px;
  padding: 0.5rem 0.75rem;
  font-size: 0.8rem;
  overflow-x: auto;
  max-height: 280px;
  color: #f1f5f9;
  line-height: 1.4;
}

code {
  font-family: inherit;
  background: rgba(255, 255, 255, 0.06);
  padding: 0.1em 0.3em;
  border-radius: 3px;
}

.empty-log-notice {
  text-align: center;
  padding: 3rem 1rem;
  background: var(--surface);
  border: 1px dashed var(--surface-border);
  color: var(--text-muted);
}
`;

/**
 * Render a complete standalone HTML document over published readings.
 */
export function renderFullPageHtml(readings: Reading[], options: FullPageOptions = {}): string {
  const title = options.title ?? "1F512 — Commitments about crypto holdings";
  const bodyContent = renderLogHtml(readings, options);
  const T = options.T ?? Date.now();

  return [
    `<!DOCTYPE html>`,
    `<html lang="en">`,
    `<head>`,
    `  <meta charset="utf-8">`,
    `  <meta name="viewport" content="width=device-width, initial-scale=1">`,
    `  <title>${escapeHtml(title)}</title>`,
    options.includeStyles !== false ? `  <style>\n${DEFAULT_STYLES}\n  </style>` : "",
    `</head>`,
    `<body>`,
    `  <div class="page-wrapper">`,
    `    <header class="page-header">`,
    `      <h1>${escapeHtml(title)}</h1>`,
    `      <div class="subtitle">Falsifiable locks — catch breaks and silence without trusting a status page</div>`,
    `      <div class="philosophy-banner">`,
    `        <p><strong>Render the log, never a second source of truth:</strong> This page renders published JSONL readings directly. A stranger with an RPC recomputes it byte-for-byte.</p>`,
    `        <p>Current page evaluation timestamp T: <code>${new Date(T).toISOString()}</code> (${T}).</p>`,
    `      </div>`,
    `    </header>`,
    `    <main>`,
    bodyContent,
    `    </main>`,
    `  </div>`,
    `</body>`,
    `</html>`,
  ].filter(Boolean).join("\n");
}
