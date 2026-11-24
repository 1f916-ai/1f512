// Ambient Web Crypto globals used by src/sign.ts under Node's webcrypto.
// Kept out of runtime: .d.ts only. Lets tsconfig stay Node-typed without pulling
// in the full DOM lib (which fights @types/node's Uint8Array/ArrayBuffer).
import type { webcrypto } from "node:crypto";

declare global {
  type CryptoKey = webcrypto.CryptoKey;
  type CryptoKeyPair = webcrypto.CryptoKeyPair;
}

export {};
