/**
 * Pins the signing implementation against the gateway verifier
 * (gateway/internal/auth/verify.go).
 *
 * 1. Rebuilds the canonical string independently, exactly as the Go side does:
 *
 *      canonical := strings.Join([]string{
 *          strings.ToLower(method),
 *          path,
 *          hex.EncodeToString(sha256(body)),
 *          strconv.FormatInt(ts, 10),
 *          idemKey,
 *      }, "\n")
 *
 *    and asserts sign.ts produces the identical string.
 *
 * 2. Verifies the produced signature with an independent Ed25519 verify over
 *    those canonical bytes (same check as Go's ed25519.Verify), using the
 *    public key derived from the seed — a full roundtrip of what the gateway
 *    does with the registered pub_spend_key.
 */
import { createHash } from "node:crypto";
import * as ed from "@noble/ed25519";
import { canonicalString, signRequest, buildHeaders, generateKeyPair, publicKeyFromSeed } from "../src/sign.js";

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok || !detail ? "" : ` — ${detail}`}`);
  if (!ok) failures++;
}

// Fixed inputs.
const method = "POST";
const path = "/v1/playce/lobby/challenge";
const body = JSON.stringify({ opponent: "glass", room_id: "pit" });
const timestamp = "1750000000";
const idem = "11111111-2222-3333-4444-555555555555";

// 1. Canonical string — rebuilt by hand, no sign.ts code.
const bodyHashHex = createHash("sha256").update(body).digest("hex");
const expected = ["post", path, bodyHashHex, timestamp, idem].join("\n");
const actual = canonicalString({ method, path, body, timestamp, idempotencyKey: idem });
check("canonical string matches verify.go construction", actual === expected, `\nexpected: ${JSON.stringify(expected)}\nactual:   ${JSON.stringify(actual)}`);

// Empty body + empty idempotency key (GET requests sign sha256("") and "").
const expectedGet = ["get", "/v1/playce/lobby/ready", createHash("sha256").update("").digest("hex"), timestamp, ""].join("\n");
const actualGet = canonicalString({ method: "GET", path: "/v1/playce/lobby/ready", body: "", timestamp });
check("canonical string for GET with empty body", actualGet === expectedGet);

// 2. Signature roundtrip: gateway-side verification of our signature.
const kp = generateKeyPair();
const { signature, timestamp: ts } = signRequest({ privateKey: kp.privateKey, method, path, body, idempotencyKey: idem, timestamp });
check("signRequest uses the injected timestamp", ts === timestamp);

const canonicalBytes = new TextEncoder().encode(expected);
const sigBytes = Uint8Array.from(Buffer.from(signature, "base64"));
const pubBytes = Uint8Array.from(Buffer.from(kp.publicKeyBase64, "base64")); // what /join registers
check("Ed25519 verify(pub_spend_key, sig, canonical) passes", ed.verify(sigBytes, canonicalBytes, pubBytes));

// Tampered canonical must fail.
const tampered = ["post", path, bodyHashHex, "1750000001", idem].join("\n");
check("tampered timestamp fails verification", !ed.verify(sigBytes, new TextEncoder().encode(tampered), pubBytes));

// publicKeyFromSeed agrees with generateKeyPair.
const seedB64 = Buffer.from(kp.privateKey).toString("base64");
check("publicKeyFromSeed(seed) === generated public key", publicKeyFromSeed(seedB64) === kp.publicKeyBase64);

// 3. Headers carry exactly what the verifier reads.
const headers = buildHeaders({ agentId: "agt_test", privateKey: kp.privateKey, method, path, body, idempotencyKey: idem });
check(
  "headers: X-Agent-Id / X-Timestamp / X-Signature / X-Idempotency-Key",
  headers["X-Agent-Id"] === "agt_test" && !!headers["X-Timestamp"] && !!headers["X-Signature"] && headers["X-Idempotency-Key"] === idem,
);

if (failures > 0) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log("\nall checks passed");
