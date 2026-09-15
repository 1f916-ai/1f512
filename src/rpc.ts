// Asking a chain a question, twice, from two different places.
//
// This is the only file in the project that talks to the network, and it is
// deliberately thin. It does not decide verdicts, it does not retry until it
// gets the answer it wants, and it does not know what a commitment is. It asks,
// it records what came back, and it hands both answers to agreement.ts.
//
// The one rule it enforces itself: A PROVIDER IS A LABEL AND A URL, AND ONLY
// THE LABEL IS EVER PUBLISHED. RPC endpoints routinely carry the API key in the
// path -- https://site.example/v2/<key> -- and this project's log is
// append-only, signed, and public. A key recorded there is a key published
// forever. The URL lives in configuration and dies there.

import { assertProviderLabel } from "./reading.ts";
import type { Attempt } from "./agreement.ts";

export interface Provider {
  /** Published. Short, no slashes, never a URL. */
  label: string;
  /** NEVER published. May contain an API key. */
  url: string;
}

export interface JsonRpcRequest {
  method: string;
  params: unknown[];
}

export interface FetchLike {
  (url: string, init: { method: string; headers: Record<string, string>; body: string; signal?: AbortSignal }): Promise<{
    ok: boolean;
    status: number;
    json: () => Promise<unknown>;
  }>;
}

export interface AskOptions {
  timeoutMs?: number;
  fetchImpl?: FetchLike;
  /** Injected so callers can pin a height; see askBoth. */
  now?: () => number;
}

const DEFAULT_TIMEOUT = 15_000;

/**
 * Put one question to one provider. Never throws: a failure is a result, and
 * the caller has to be able to record it.
 *
 * Errors are stringified and TRUNCATED, and the URL is scrubbed out of them.
 * Provider error text routinely echoes the request URL back, which is how a key
 * escapes into a log that was careful everywhere else.
 */
export async function ask(p: Provider, req: JsonRpcRequest, at_block: number, opts: AskOptions = {}): Promise<Attempt> {
  assertProviderLabel(p.label);
  const f = opts.fetchImpl ?? (globalThis.fetch as unknown as FetchLike);
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), opts.timeoutMs ?? DEFAULT_TIMEOUT);
  try {
    const res = await f(p.url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: req.method, params: req.params }),
      signal: ac.signal,
    });
    if (!res.ok) return { provider: p.label, ok: false, error: scrub(`http ${res.status}`, p.url) };
    const body = (await res.json()) as { result?: unknown; error?: { message?: string } };
    // A JSON-RPC error beside a result is an ERROR. The result does not count:
    // a provider that returns both is telling you it failed and handing you
    // something anyway, and taking the something is how a bad answer becomes a
    // published verdict.
    if (body && typeof body === "object" && "error" in body && body.error) {
      return { provider: p.label, ok: false, error: scrub(String(body.error.message ?? "rpc error"), p.url) };
    }
    if (!body || !("result" in body)) {
      return { provider: p.label, ok: false, error: "response carried neither result nor error" };
    }
    return { provider: p.label, ok: true, result: body.result, at_block };
  } catch (e) {
    const msg = e instanceof Error && e.name === "AbortError" ? "timeout" : String(e);
    return { provider: p.label, ok: false, error: scrub(msg, p.url) };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Remove the endpoint URL from any text that is about to be recorded. Belt and
 * braces: assertProviderLabel already stops a URL becoming a label, and this
 * stops one arriving inside an error message.
 */
export function scrub(text: string, url: string): string {
  let out = text.split(url).join("<provider-url>");
  try {
    const u = new URL(url);
    // Also strip the bare host and any path segment that looks like a key, in
    // case the provider echoes a normalised form rather than the exact string.
    out = out.split(u.host).join("<provider-host>");
    for (const seg of u.pathname.split("/")) {
      if (seg.length >= 16) out = out.split(seg).join("<redacted>");
    }
  } catch {
    // A malformed URL is a configuration bug, not a reason to leak the raw text.
    return out.slice(0, 200);
  }
  return out.slice(0, 200);
}

/**
 * Ask two providers the same question, pinned to the same block.
 *
 * PINNED TO THE SAME BLOCK, and that is the point of this function existing at
 * all. Two providers asked "what is it now" answer about different heights and
 * disagree for reasons that have nothing to do with the commitment. The caller
 * chooses the height; this just makes sure both were asked about it.
 */
export async function askBoth(
  providers: [Provider, Provider],
  req: JsonRpcRequest,
  at_block: number,
  opts: AskOptions = {},
): Promise<Attempt[]> {
  const [a, b] = providers;
  if (a.label === b.label) {
    // Refused here as well as in agreement.ts. A caller that configures the
    // same provider twice has made a configuration mistake that produces a log
    // claiming consensus, and it should fail loudly at the point of the
    // mistake rather than quietly at the point of the record.
    throw new Error(`askBoth needs two DIFFERENT providers; both are labelled ${JSON.stringify(a.label)}`);
  }
  return Promise.all([ask(a, req, at_block, opts), ask(b, req, at_block, opts)]);
}
