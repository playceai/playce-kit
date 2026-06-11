/**
 * Ed25519 request signing for the Playce gateway. Self-contained.
 *
 * The canonical signing string matches the gateway verifier exactly
 * (gateway/internal/auth/verify.go — CanonicalString):
 *
 *     strings.Join([]string{
 *         strings.ToLower(method),
 *         path,
 *         hex.EncodeToString(sha256(body)),
 *         strconv.FormatInt(ts, 10),
 *         idemKey,
 *     }, "\n")
 *
 * i.e. five lines joined by "\n":
 *     lower(method) \n path \n sha256hex(body) \n unix_timestamp \n idempotency_key
 *
 * The signature is Ed25519 over the UTF-8 bytes of that string, base64-encoded,
 * sent with headers X-Agent-Id / X-Timestamp / X-Signature / X-Idempotency-Key.
 * Timestamps more than 5 minutes from server time are rejected.
 */
import { createHash } from "node:crypto";
import * as ed from "@noble/ed25519";
import { sha512 } from "@noble/hashes/sha512";

// @noble/ed25519 v2 needs a sync sha512 implementation wired in.
ed.etc.sha512Sync = (...m: Uint8Array[]) => sha512(ed.etc.concatBytes(...m));

export interface KeyPair {
  privateKey: Uint8Array; // 32-byte seed
  publicKey: Uint8Array;
  publicKeyBase64: string;
}

/** Generate a fresh Ed25519 keypair (only needed if you don't have one yet). */
export function generateKeyPair(): KeyPair {
  const privateKey = ed.utils.randomPrivateKey();
  const publicKey = ed.getPublicKey(privateKey);
  return { privateKey, publicKey, publicKeyBase64: Buffer.from(publicKey).toString("base64") };
}

/** Derive the base64 public key from a base64-encoded 32-byte seed. */
export function publicKeyFromSeed(seedBase64: string): string {
  const seed = Uint8Array.from(Buffer.from(seedBase64, "base64"));
  return Buffer.from(ed.getPublicKey(seed)).toString("base64");
}

/** Build the exact string the gateway verifies. Exported so tests can pin it. */
export function canonicalString(opts: {
  method: string;
  path: string;
  body: string;
  timestamp: string;
  idempotencyKey?: string;
}): string {
  const bodyHash = createHash("sha256").update(opts.body || "").digest("hex");
  return [opts.method.toLowerCase(), opts.path, bodyHash, opts.timestamp, opts.idempotencyKey || ""].join("\n");
}

/** Sign one request. Returns the timestamp used and the base64 signature. */
export function signRequest(opts: {
  privateKey: Uint8Array;
  method: string;
  path: string;
  body: string;
  idempotencyKey?: string;
  timestamp?: string; // injectable for tests; defaults to now
}): { timestamp: string; signature: string } {
  const timestamp = opts.timestamp ?? Math.floor(Date.now() / 1000).toString();
  const canonical = canonicalString({ ...opts, timestamp });
  const sig = ed.sign(new TextEncoder().encode(canonical), opts.privateKey);
  return { timestamp, signature: Buffer.from(sig).toString("base64") };
}

/** Full header set for a signed Playce request. */
export function buildHeaders(opts: {
  agentId: string;
  privateKey: Uint8Array;
  method: string;
  path: string;
  body: string;
  idempotencyKey?: string;
}): Record<string, string> {
  const { timestamp, signature } = signRequest(opts);
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "X-Agent-Id": opts.agentId,
    "X-Timestamp": timestamp,
    "X-Signature": signature,
  };
  if (opts.idempotencyKey) headers["X-Idempotency-Key"] = opts.idempotencyKey;
  return headers;
}
