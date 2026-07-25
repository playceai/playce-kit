/**
 * Coyns OAuth 2.1 machine-to-machine token minting.
 *
 * Flow: sign a server-issued challenge locally with your Ed25519 spend key —
 * the exact same raw-nonce signing scripts/setup.ts already uses to activate
 * a Coyns registration (ed.sign over the bare UTF-8 bytes), no new primitive
 * — and exchange the signature for a short-lived, scoped bearer token. No
 * human, no browser, no PKCE: this is machine-to-machine (see
 * docs/mcp-auth-plan.md, Flow B).
 *
 * Canonical constants (must match Coyns byte-for-byte): scope defaults to
 * "read play"; endpoints are POST {base}/v1/oauth/challenge and
 * POST {base}/v1/oauth/token.
 */
import * as ed from "@noble/ed25519";
import "./sign.js"; // installs the sha512 shim on `ed` as a side effect

const DEFAULT_COYNS_BASE_URL = "https://api.coyns.com";
const REFRESH_MARGIN_MS = 60_000;

export interface MintAccessTokenOptions {
  agentId: string;
  privateKey: Uint8Array; // 32-byte seed
  scope?: string; // omit for Coyns' default grant (read + play)
  coynsBaseUrl?: string;
}

export interface AccessToken {
  token: string;
  expiresAt: number; // ms since epoch
}

// Same tiny shape as scripts/setup.ts's post() helper — not imported from
// there directly, since that script unconditionally runs its own main() at
// module load (importing it would trigger a live registration attempt).
async function post(url: string, body: object): Promise<{ status: number; data: any }> {
  const r = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await r.json().catch(() => ({}));
  return { status: r.status, data };
}

/** Mint a fresh Coyns access token: challenge -> sign -> token. */
export async function mintAccessToken(opts: MintAccessTokenOptions): Promise<AccessToken> {
  const base = opts.coynsBaseUrl || process.env.COYNS_BASE_URL || DEFAULT_COYNS_BASE_URL;

  const challengeResp = await post(`${base}/v1/oauth/challenge`, { agent_id: opts.agentId });
  if (challengeResp.status >= 400 || !challengeResp.data?.challenge) {
    throw new Error(`oauth challenge failed: HTTP ${challengeResp.status} ${JSON.stringify(challengeResp.data)}`);
  }
  const challenge: string = challengeResp.data.challenge;

  // Raw-nonce signing — mirrors scripts/setup.ts's complete() exactly:
  // ed.sign over the bare UTF-8 bytes of the server-issued string.
  const sig = ed.sign(new TextEncoder().encode(challenge), opts.privateKey);

  const tokenResp = await post(`${base}/v1/oauth/token`, {
    agent_id: opts.agentId,
    challenge,
    signature: Buffer.from(sig).toString("base64"),
    ...(opts.scope ? { scope: opts.scope } : {}),
  });
  if (tokenResp.status >= 400 || !tokenResp.data?.access_token) {
    throw new Error(`oauth token failed: HTTP ${tokenResp.status} ${JSON.stringify(tokenResp.data)}`);
  }

  const expiresIn: number = tokenResp.data.expires_in ?? 900;
  return {
    token: tokenResp.data.access_token,
    expiresAt: Date.now() + expiresIn * 1000,
  };
}

let cached: { key: string; token: AccessToken } | null = null;

function cacheKey(opts: MintAccessTokenOptions): string {
  return `${opts.coynsBaseUrl || DEFAULT_COYNS_BASE_URL}:${opts.agentId}:${opts.scope || ""}`;
}

/** Mint once, reuse until close to expiry (60s margin), then re-mint. */
export async function getCachedToken(opts: MintAccessTokenOptions): Promise<AccessToken> {
  const key = cacheKey(opts);
  if (cached && cached.key === key && cached.token.expiresAt - REFRESH_MARGIN_MS > Date.now()) {
    return cached.token;
  }
  const token = await mintAccessToken(opts);
  cached = { key, token };
  return token;
}

/** Force the next getCachedToken call to mint fresh (e.g. after a 401). */
export function invalidateCachedToken(): void {
  cached = null;
}
