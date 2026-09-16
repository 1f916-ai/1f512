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

import { Buffer } from "node:buffer";
import { createHmac } from "node:crypto";
import { canonical, type Reading } from "./reading.ts";
import type { Address, Commitment } from "./commitment.ts";
import { canonicalFiling } from "./commitment.ts";

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

// ---------------------------------------------------------------------------
// Key-bound filing: subject signatures (EIP-191 personal_sign)
// ---------------------------------------------------------------------------
//
// An entry in the registry is a promise about an address. A signature on that
// filing proves WHO made the promise: the key controlling the subject address,
// or a third party filing about someone else.
//
// Invariant (same ordering as above):
//   1. Recomputable (the RPC inputs)
//   2. Chained (the log hash)
//   3. Signed (the subject key)
//
// A signature never changes a verdict. It says who made the promise, never
// whether the chain kept it. An unfalsifiable commitment signed by the subject
// is still refused; a broken commitment signed by the subject is still BROKEN.

const RC = [
  0x0000000000000001n, 0x0000000000008082n, 0x800000000000808an, 0x8000000080008000n,
  0x000000000000808bn, 0x0000000080000001n, 0x8000000080008081n, 0x8000000000008009n,
  0x000000000000008an, 0x0000000000000088n, 0x0000000080008009n, 0x000000008000000an,
  0x000000008000808bn, 0x800000000000008bn, 0x8000000000008089n, 0x8000000000008003n,
  0x8000000000008002n, 0x8000000000000080n, 0x000000000000800an, 0x800000008000000an,
  0x8000000080008081n, 0x8000000000008080n, 0x0000000080000001n, 0x8000000080008008n,
];

const RHO = [
  [0, 36, 3, 41, 18],
  [1, 44, 10, 45, 2],
  [62, 6, 43, 15, 61],
  [28, 55, 25, 21, 56],
  [27, 20, 39, 8, 14],
];

function rol64(x: bigint, n: number): bigint {
  const bn = BigInt(n);
  return ((x << bn) | (x >> (64n - bn))) & 0xffffffffffffffffn;
}

function keccakF1600(state: bigint[]): void {
  for (let round = 0; round < 24; round++) {
    const C = new Array<bigint>(5);
    for (let x = 0; x < 5; x++) {
      C[x] = state[x]! ^ state[x + 5]! ^ state[x + 10]! ^ state[x + 15]! ^ state[x + 20]!;
    }
    const D = new Array<bigint>(5);
    for (let x = 0; x < 5; x++) {
      D[x] = C[(x + 4) % 5]! ^ rol64(C[(x + 1) % 5]!, 1);
    }
    for (let x = 0; x < 5; x++) {
      for (let y = 0; y < 5; y++) {
        state[x + y * 5]! ^= D[x]!;
      }
    }
    const B = new Array<bigint>(25);
    for (let x = 0; x < 5; x++) {
      for (let y = 0; y < 5; y++) {
        B[y + ((2 * x + 3 * y) % 5) * 5] = rol64(state[x + y * 5]!, RHO[x]![y]!);
      }
    }
    for (let x = 0; x < 5; x++) {
      for (let y = 0; y < 5; y++) {
        state[x + y * 5] = B[x + y * 5]! ^ ((~B[((x + 1) % 5) + y * 5]!) & B[((x + 2) % 5) + y * 5]!);
      }
    }
    state[0]! ^= RC[round]!;
  }
}

/** Pure Keccak-256 (Ethereum standard padding 0x01 ... 0x80). */
export function keccak256(data: Uint8Array | string): Buffer {
  const msg = typeof data === "string" ? Buffer.from(data, "utf8") : Buffer.from(data);
  const rate = 136; // 1088 bits
  const state = new Array<bigint>(25).fill(0n);
  const padLen = rate - (msg.length % rate);
  const padded = Buffer.alloc(msg.length + padLen);
  msg.copy(padded, 0);
  if (padLen === 1) {
    padded[msg.length] = 0x81;
  } else {
    padded[msg.length] = 0x01;
    padded[padded.length - 1] = 0x80;
  }
  for (let blockStart = 0; blockStart < padded.length; blockStart += rate) {
    for (let i = 0; i < rate / 8; i++) {
      state[i] = state[i]! ^ padded.readBigUInt64LE(blockStart + i * 8);
    }
    keccakF1600(state);
  }
  const out = Buffer.alloc(32);
  for (let i = 0; i < 4; i++) {
    out.writeBigUInt64LE(state[i]!, i * 8);
  }
  return out;
}

/** EIP-191 personal_sign message digest: keccak256("\x19Ethereum Signed Message:\n" + len + msg) */
export function personalSignHash(message: string | Uint8Array): Buffer {
  const msgBuf = typeof message === "string" ? Buffer.from(message, "utf8") : Buffer.from(message);
  const prefix = Buffer.from("\x19Ethereum Signed Message:\n" + msgBuf.length, "utf8");
  return keccak256(Buffer.concat([prefix, msgBuf]));
}

// secp256k1 curve parameters
const P = 0xfffffffffffffffffffffffffffffffffffffffffffffffffffffffefffffc2fn;
const N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
const Gx = 0x79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798n;
const Gy = 0x483ada7726a3c4655da4fbfc0e1108a8fd17b448a68554199c47d08ffb10d4b8n;

function mod(a: bigint, m: bigint = P): bigint {
  const res = a % m;
  return res >= 0n ? res : res + m;
}

function invMod(a: bigint, m: bigint = P): bigint {
  let [t, newT] = [0n, 1n];
  let [rem, newR] = [m, mod(a, m)];
  while (newR !== 0n) {
    const q = rem / newR;
    [t, newT] = [newT, t - q * newT];
    [rem, newR] = [newR, rem - q * newR];
  }
  if (rem > 1n) throw new Error("not invertible");
  return t < 0n ? t + m : t;
}

function modPow(b: bigint, exp: bigint, m: bigint = P): bigint {
  let res = 1n;
  let base = mod(b, m);
  let e = exp;
  while (e > 0n) {
    if (e & 1n) res = mod(res * base, m);
    base = mod(base * base, m);
    e >>= 1n;
  }
  return res;
}

type AffinePoint = [bigint, bigint] | null;

function pointAdd(p1: AffinePoint, p2: AffinePoint): AffinePoint {
  if (!p1) return p2;
  if (!p2) return p1;
  const [x1, y1] = p1;
  const [x2, y2] = p2;
  if (x1 === x2) {
    if (y1 !== y2) return null; // point at infinity
    if (y1 === 0n) return null;
    const m = mod(mod(3n * mod(x1 * x1, P), P) * invMod(2n * y1, P), P);
    const x3 = mod(m * m - 2n * x1, P);
    const y3 = mod(m * (x1 - x3) - y1, P);
    return [x3, y3];
  }
  const m = mod(mod(y2 - y1, P) * invMod(x2 - x1, P), P);
  const x3 = mod(m * m - x1 - x2, P);
  const y3 = mod(m * (x1 - x3) - y1, P);
  return [x3, y3];
}

function pointMul(k: bigint, p: AffinePoint): AffinePoint {
  let res: AffinePoint = null;
  let cur: AffinePoint = p;
  let scalar = mod(k, N);
  while (scalar > 0n) {
    if (scalar & 1n) res = pointAdd(res, cur);
    cur = pointAdd(cur, cur);
    scalar >>= 1n;
  }
  return res;
}

export function pubkeyToAddress(pubX: bigint, pubY: bigint): Address {
  const buf = Buffer.alloc(64);
  buf.write(pubX.toString(16).padStart(64, "0"), 0, 32, "hex");
  buf.write(pubY.toString(16).padStart(64, "0"), 32, 32, "hex");
  const hash = keccak256(buf);
  return ("0x" + hash.subarray(12).toString("hex").toLowerCase()) as Address;
}

/**
 * Recover the signer address from an EIP-191 personal_sign signature (r, s, v).
 *
 * Throws if the signature format is malformed, r/s out of bounds, s is malleable (EIP-2),
 * or r does not define a point on secp256k1.
 */
export function recoverPersonalSign(message: string | Uint8Array, sigHex: string): Address {
  if (typeof sigHex !== "string") throw new Error("signature must be a string");
  const raw = sigHex.replace(/^0x/, "").toLowerCase();
  if (!/^[0-9a-f]{130}$/.test(raw)) {
    throw new Error(`signature must be a 65-byte hex string (got ${sigHex.length} characters)`);
  }
  const r = BigInt("0x" + raw.slice(0, 64));
  const s = BigInt("0x" + raw.slice(64, 128));
  let v = parseInt(raw.slice(128, 130), 16);
  if (v >= 27) v -= 27;
  if (v !== 0 && v !== 1) throw new Error(`invalid recovery id v: ${raw.slice(128, 130)} (expected 27 or 28)`);
  if (r <= 0n || r >= N) throw new Error("r out of range [1, N-1]");
  if (s <= 0n || s >= N) throw new Error("s out of range [1, N-1]");
  if (s > N / 2n) throw new Error("malleable signature: s must be in lower half of curve order (EIP-2)");

  const hash = personalSignHash(message);
  const e = BigInt("0x" + hash.toString("hex"));

  const x = r;
  const y2 = mod(mod(x * mod(x * x, P), P) + 7n, P);
  let y = modPow(y2, (P + 1n) / 4n, P);
  if (mod(y * y, P) !== y2) throw new Error("r is not a valid point on secp256k1");
  if ((y % 2n) !== BigInt(v)) y = P - y;

  const R: AffinePoint = [x, y];
  const sR = pointMul(s, R);
  const negEG = pointMul(mod(N - mod(e, N), N), [Gx, Gy]);
  const pt = pointAdd(sR, negEG);
  const Q = pointMul(invMod(r, N), pt);
  if (!Q) throw new Error("could not recover public key");
  return pubkeyToAddress(Q[0], Q[1]);
}

function deterministicK(hashBuf: Buffer, privKeyBuf: Buffer): bigint {
  let v = Buffer.alloc(32, 0x01);
  let k = Buffer.alloc(32, 0x00);
  k = createHmac("sha256", k).update(Buffer.concat([v, Buffer.from([0x00]), privKeyBuf, hashBuf])).digest();
  v = createHmac("sha256", k).update(v).digest();
  k = createHmac("sha256", k).update(Buffer.concat([v, Buffer.from([0x01]), privKeyBuf, hashBuf])).digest();
  v = createHmac("sha256", k).update(v).digest();
  while (true) {
    v = createHmac("sha256", k).update(v).digest();
    const candidate = BigInt("0x" + v.toString("hex"));
    if (candidate >= 1n && candidate < N) return candidate;
    k = createHmac("sha256", k).update(Buffer.concat([v, Buffer.from([0x00])])).digest();
    v = createHmac("sha256", k).update(v).digest();
  }
}

/**
 * Sign a message using EIP-191 personal_sign with RFC 6979 deterministic k.
 *
 * Returns 65-byte hex string prefixed with 0x: 32 bytes r + 32 bytes s + 1 byte (v + 27).
 */
export function signPersonal(message: string | Uint8Array, privKeyHex: string): string {
  const hash = personalSignHash(message);
  const e = BigInt("0x" + hash.toString("hex"));
  const rawPriv = privKeyHex.replace(/^0x/, "");
  if (!/^[0-9a-fA-F]{64}$/.test(rawPriv)) {
    throw new Error("private key must be a 32-byte hex string");
  }
  const privKeyBuf = Buffer.from(rawPriv, "hex");
  const d = BigInt("0x" + rawPriv);
  if (d <= 0n || d >= N) throw new Error("private key out of range [1, N-1]");

  const k = deterministicK(hash, privKeyBuf);
  const R = pointMul(k, [Gx, Gy]);
  if (!R) throw new Error("could not generate R point");
  const r = mod(R[0], N);
  if (r === 0n) throw new Error("r is 0");
  let s = mod(invMod(k, N) * mod(e + r * d, N), N);
  if (s === 0n) throw new Error("s is 0");
  let v = Number(R[1] % 2n);
  if (s > N / 2n) {
    s = N - s;
    v = 1 - v;
  }
  return (
    "0x" +
    r.toString(16).padStart(64, "0") +
    s.toString(16).padStart(64, "0") +
    (v + 27).toString(16).padStart(2, "0")
  );
}

/** Sign a canonical filing using the subject's private key. */
export function signFiling(c: Commitment, privKeyHex: string): string {
  return signPersonal(canonicalFiling(c), privKeyHex);
}

export interface SignatureVerification {
  ok: boolean;
  signer?: Address;
  problem?: "missing_signature" | "invalid_format" | "invalid_signature" | "signer_mismatch";
  reason?: string;
}

/**
 * Verify a commitment's signature against its subject address.
 */
export function verifyFilingSignature(c: Commitment): SignatureVerification {
  if (c.sig === undefined) {
    return { ok: false, problem: "missing_signature", reason: "no signature provided" };
  }
  let signer: Address;
  try {
    signer = recoverPersonalSign(canonicalFiling(c), c.sig);
  } catch (e) {
    return { ok: false, problem: "invalid_signature", reason: (e as Error).message };
  }
  if (signer.toLowerCase() !== c.predicate.subject.toLowerCase()) {
    return {
      ok: false,
      problem: "signer_mismatch",
      signer,
      reason: `signature was made by ${signer}, not subject ${c.predicate.subject}`,
    };
  }
  return { ok: true, signer };
}
