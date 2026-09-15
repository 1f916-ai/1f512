// Signing the log, and being precise about what a signature is worth.
//
// The reading record already gives a reader the strongest property this project
// has: every line carries the RPC calls that produced it, so the verdict can be
// recomputed without trusting anyone. The hash chain gives the second: lines
// cannot be reordered or removed after the fact.
//
// A signature gives the third and weakest. It says WHO wrote a line. It does not
// say the line is true, and it cannot -- an operator with the key can sign a
// verdict they invented. Anyone reading a signed log and feeling reassured by
// the signature has mistaken authorship for evidence.
//
// So the ordering in reading.ts holds here: recomputable, then chained, then
// signed. This file is last on purpose, and it is the smallest.
//
// WHAT IT IS ACTUALLY FOR. Not "trust this log" -- it is so a reader can tell
// this operator's log from someone else's copy with lines added. Without it,
// anyone can publish a well-formed chain claiming to be ours. That is a real
// attack and this closes it, and it closes nothing else.

import { canonical, type Reading } from "./reading.ts";

export interface SignedHead {
  /** The hash of the last line this signature covers. */
  head: string;
  /** How many lines are covered. A head alone does not say how much log it summarises. */
  count: number;
  /** ms since epoch, when the signature was made. */
  signed_at: number;
  /** base64url. */
  sig: string;
  /** base64url raw public key, so a reader needs nothing but this object. */
  key: string;
}

const enc = new TextEncoder();

function b64u(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64url");
}

function unb64u(s: string): Uint8Array {
  return new Uint8Array(Buffer.from(s, "base64url"));
}

/** Generate an Ed25519 keypair. The private key never leaves the caller. */
export async function generateKey(): Promise<CryptoKeyPair> {
  return (await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"])) as CryptoKeyPair;
}

export async function exportPublicKey(pair: CryptoKeyPair): Promise<string> {
  return b64u(new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey)));
}

/**
 * The bytes a head signature covers.
 *
 * signed_at is in here because two heads over the same log at different times
 * are two different statements about when the operator last looked. Without it
 * an old head could be restamped to claim a fresher reading than was taken.
 *
 * COUNT IS IN HERE AND IS REDUNDANT, stated plainly because the first version
 * of this comment claimed it was load-bearing and it is not. The reasoning that
 * was wrong: "a signature over the head alone says nothing about length, so it
 * could be replayed against a truncated log ending at the same hash." But the
 * head chains all the way back, so a shorter log ending at the same hash needs
 * a collision -- the head already determines the log. What actually catches
 * truncation is the explicit count comparison in verifyHead, not this field.
 *
 * It is kept because it costs nothing, it makes the signed object
 * self-describing, and it would become load-bearing if the chain construction
 * ever changed. But no mutation of this file kills a test by removing it, and
 * a guard nobody can demonstrate should say so rather than be described as a
 * defence.
 */
export function headPreimage(head: string, count: number, signed_at: number): string {
  return canonical({ "1f512.head.v1": true, head, count, signed_at });
}

export async function signHead(lines: Reading[], pair: CryptoKeyPair, signed_at: number): Promise<SignedHead> {
  const head = lines.length === 0 ? "" : lines[lines.length - 1]!.hash;
  const count = lines.length;
  const sig = await crypto.subtle.sign(
    { name: "Ed25519" },
    pair.privateKey,
    enc.encode(headPreimage(head, count, signed_at)),
  );
  return { head, count, signed_at, sig: b64u(new Uint8Array(sig)), key: await exportPublicKey(pair) };
}

export interface HeadCheck {
  ok: boolean;
  /** Machine-readable. Callers branch on this. */
  problem?: "bad_signature" | "head_mismatch" | "count_mismatch" | "unusable_key";
  detail?: string;
}

/**
 * Check a signed head against a log.
 *
 * Verifies BOTH that the signature is genuine AND that it describes the log in
 * front of you. A caller that checks only the signature has verified that
 * someone signed something, which is not the question they meant to ask.
 */
export async function verifyHead(lines: Reading[], sh: SignedHead): Promise<HeadCheck> {
  let key: CryptoKey;
  try {
    key = await crypto.subtle.importKey("raw", unb64u(sh.key), { name: "Ed25519" }, false, ["verify"]);
  } catch (e) {
    return { ok: false, problem: "unusable_key", detail: String(e).slice(0, 160) };
  }

  const good = await crypto.subtle.verify(
    { name: "Ed25519" },
    key,
    unb64u(sh.sig),
    enc.encode(headPreimage(sh.head, sh.count, sh.signed_at)),
  );
  if (!good) return { ok: false, problem: "bad_signature", detail: "the signature does not match the head it claims" };

  // The signature is genuine. Now: is it about THIS log?
  const actualHead = lines.length === 0 ? "" : lines[lines.length - 1]!.hash;
  if (sh.count !== lines.length) {
    return {
      ok: false,
      problem: "count_mismatch",
      detail: `signature covers ${sh.count} lines, the log has ${lines.length}`,
    };
  }
  if (sh.head !== actualHead) {
    return {
      ok: false,
      problem: "head_mismatch",
      detail: `signature covers head ${sh.head.slice(0, 16) || "(empty)"}, the log ends at ${actualHead.slice(0, 16) || "(empty)"}`,
    };
  }
  return { ok: true };
}
