// The reading record: one line of the log, shaped so a stranger can recompute it.
//
// The selected proposal's requirement is not that we publish verdicts. It is
// that "Each row carries the RPC inputs, not just the verdict, so a stranger
// with an RPC recomputes it byte-for-byte." A verdict a reader has to trust is
// a status page. This file is the difference.
//
// Three properties, in the order they matter:
//
//   1. RECOMPUTABLE. The line records the questions asked of the chain and the
//      answers received, so the verdict can be re-derived without running any
//      of our code. Everything else here protects that.
//   2. CHAINED. Each line commits to its predecessor, so a line cannot be
//      removed or reordered after the fact without breaking every line after
//      it. Append-only is a property of the data, not a promise about us.
//   3. SIGNED. Each line commits to a key, so a line cannot be inserted by
//      someone who is not the operator. This is the weakest of the three and
//      is deliberately last: a signature proves who wrote it, never that what
//      they wrote is true. Only property 1 does that.

export const VERDICTS = ["HELD", "BROKEN", "UNREADABLE", "DEFAULTED"] as const;
export type Verdict = (typeof VERDICTS)[number];

/** One question put to one chain endpoint, and the answer it gave. */
export interface RpcExchange {
  /** A stable label for the endpoint, NEVER its URL. See the note below. */
  provider: string;
  method: string;
  params: unknown[];
  /** The response as received. This is what a stranger re-derives from. */
  result: unknown;
  /** Block height the answer was pinned to, so a later reader asks the same question. */
  at_block: number;
}

export interface ReadingContent {
  commitment: string;
  verdict: Verdict;
  /** Why, in a form a machine can branch on. Prose belongs in `note`. */
  reason: string;
  /** Every exchange that produced this verdict. At least two, or the verdict is UNREADABLE. */
  rpc: RpcExchange[];
  /** When the reading was taken, ms since epoch, UTC. */
  read_at: number;
  note?: string;
}

export interface Reading extends ReadingContent {
  /** Hash of the previous line, or the empty string for the first. */
  prev_hash: string;
  /** sha256 over the canonical form of everything above. */
  hash: string;
  /** Signature over `hash`, base64url. Absent on an unsigned draft. */
  sig?: string;
  /** Which key signed. */
  key?: string;
}

// PROVIDER LABELS, NOT URLS, and this is a security property rather than a
// style choice. RPC endpoints routinely carry the API key in the path --
// https://site.example/v2/<key> -- so a log that faithfully recorded "the URL I
// asked" would publish that key forever, in an append-only file, signed. The
// label is what a reader needs (two DIFFERENT providers agreed) and the key is
// what they do not.
const URLISH = /^[a-z][a-z0-9+.-]*:\/\//i;

export function assertProviderLabel(provider: string): void {
  if (!provider || provider.trim() !== provider || provider.length > 64) {
    throw new Error(`provider must be a short trimmed label, got ${JSON.stringify(provider)}`);
  }
  if (URLISH.test(provider) || provider.includes("/")) {
    throw new Error(
      `provider must be a LABEL, not a URL (${JSON.stringify(provider)}). RPC URLs carry API keys; ` +
        `this log is append-only and public, so a key recorded here is a key published forever.`,
    );
  }
  // SCOPE, stated because a reader will otherwise assume more: this stops a
  // SECRET reaching the log, not a vendor's identity. A bare hostname
  // ("mainnet.base.org") passes, and should -- it carries no key, and refusing
  // every dotted string would reject reasonable labels. Found by running
  // examples/live.ts with the host as the label: the log recorded it, exactly
  // as designed.
}

// CANONICAL FORM. Two readers must hash the same bytes, so serialisation cannot
// depend on key insertion order or on how a number happened to be written.
// Keys are sorted at every depth; undefined is dropped; nothing is pretty.
//
// Numbers are the sharp edge: JSON cannot distinguish 1 from 1.0, and a chain
// value beyond 2^53 loses precision silently. Any quantity from the chain
// belongs in this record as a STRING, and this function refuses a non-integer
// or unsafe number rather than hashing a value that will not survive a round
// trip.
export function canonical(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error(`cannot canonicalise non-finite number ${value}`);
    if (!Number.isSafeInteger(value)) {
      throw new Error(
        `cannot canonicalise ${value}: only safe integers may be numbers here. ` +
          `Chain quantities must be strings, or precision is lost without anything saying so.`,
      );
    }
    return String(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (typeof value === "object") {
    const o = value as Record<string, unknown>;
    const keys = Object.keys(o).filter((k) => o[k] !== undefined).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonical(o[k])}`).join(",")}}`;
  }
  throw new Error(`cannot canonicalise ${typeof value}`);
}

async function sha256Hex(s: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * The bytes a line's hash covers: its content AND its predecessor's hash.
 * Exported because a verifier must be able to rebuild it independently --
 * a hash recipe only this file knows is not a recipe.
 */
export function preimage(content: ReadingContent, prevHash: string): string {
  return canonical({ ...content, prev_hash: prevHash });
}

export async function seal(content: ReadingContent, prevHash: string): Promise<Reading> {
  for (const x of content.rpc) assertProviderLabel(x.provider);
  if (!VERDICTS.includes(content.verdict)) throw new Error(`unknown verdict ${content.verdict}`);
  const hash = await sha256Hex(preimage(content, prevHash));
  return { ...content, prev_hash: prevHash, hash };
}

export interface ChainProblem {
  index: number;
  problem: "hash" | "link" | "order";
  detail: string;
}

/**
 * Verify a whole log. Returns every problem found, not the first -- a reader
 * deciding whether to trust this log wants the shape of the damage, and a
 * verifier that stops at the first break hides the rest.
 */
export async function verifyChain(lines: Reading[]): Promise<ChainProblem[]> {
  const problems: ChainProblem[] = [];
  let expectedPrev = "";
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (line.prev_hash !== expectedPrev) {
      problems.push({
        index: i,
        problem: "link",
        detail: `prev_hash ${line.prev_hash || "(empty)"} does not match the previous line's hash ${expectedPrev || "(empty)"}`,
      });
    }
    const { hash: _h, sig: _s, key: _k, prev_hash: _p, ...content } = line;
    const recomputed = await sha256Hex(preimage(content as ReadingContent, line.prev_hash));
    if (recomputed !== line.hash) {
      problems.push({
        index: i,
        problem: "hash",
        detail: `line hashes to ${recomputed}, but claims ${line.hash}`,
      });
    }
    // Readings are appended in time order. Going backwards is not a rounding
    // error, it is a rewritten log, so it is reported rather than tolerated.
    if (i > 0 && line.read_at < lines[i - 1]!.read_at) {
      problems.push({
        index: i,
        problem: "order",
        detail: `read_at ${line.read_at} precedes the previous line's ${lines[i - 1]!.read_at}`,
      });
    }
    // CHAIN ON THE RECOMPUTED HASH, NOT THE CLAIMED ONE. If a line's content
    // was edited and its stored hash left alone, linking on the claim would
    // break only that line and let every line after it verify cleanly -- which
    // reports the damage as smaller than it is. The real position is that
    // nothing after an edited line is anchored to anything that exists.
    expectedPrev = recomputed;
  }
  return problems;
}
