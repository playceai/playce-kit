/**
 * `pnpm fund <amount>` — pledge GOLD from your COYNS WALLET into PLAYCE.
 *
 * Playce and Coyns are two ledgers. Your Coyns wallet is your money (and where
 * a founders500/referral bonus lands); your Playce GOLD is only the part you
 * have PLEDGED for play. This script performs the two-step pledge the gateway
 * documents in `funding_note`:
 *
 *   1. Coyns  POST /v1/payments                → send <amount> GOLD to @playce_house
 *   2. Playce POST /v1/playce/deposits/register → credit your Playce ledger with
 *                                                 the returned coyns_transfer_id
 *
 * THIS MOVES YOUR OWN MONEY. So: the amount is a required argument with no
 * default, the exact plan is printed before anything is sent, and every failure
 * prints the server's own message rather than a swallowed error. Nothing else in
 * the kit pledges anything — funding is always the developer's explicit act.
 *
 * Reads AGENT_NAME / AGENT_ID / SPEND_PRIVATE_KEY from .env, falling back to
 * secrets/coyns_creds.json (written by `pnpm setup`). Optional env:
 * COYNS_BASE_URL, PLAYCE_BASE_URL, PLAYCE_HOUSE_HANDLE, PLAYCE_HOUSE_AGENT_ID.
 */
import "dotenv/config";
import { randomUUID } from "node:crypto";
import { PlayceClient } from "../src/client.js";
import { buildHeaders } from "../src/sign.js";
import { loadSavedCreds } from "../src/index.js";

const COYNS = process.env.COYNS_BASE_URL || "https://api.coyns.com";
const PLAYCE = process.env.PLAYCE_BASE_URL || "https://api.playce.ai";
const HOUSE_HANDLE = (process.env.PLAYCE_HOUSE_HANDLE || "playce_house").replace(/^@/, "");

const log = (msg: string) => console.log(msg);

function die(msg: string): never {
  console.error(msg);
  process.exit(1);
}

/** The amount must be an explicit, positive whole number of GOLD. */
export function parseAmount(raw: string | undefined): number {
  if (!raw) {
    die(
      "Usage: pnpm fund <amount>\n" +
        "  <amount> is GOLD to move from your Coyns wallet into Playce. There is no default —\n" +
        "  this spends your own funds, so you have to name the number.",
    );
  }
  const n = Number(raw);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n <= 0) {
    die(`"${raw}" is not a positive whole number of GOLD.`);
  }
  return n;
}

/** Pull the server's message out of an error body instead of printing "[object Object]". */
function serverMessage(data: unknown): string {
  if (data === null || data === undefined) return "";
  if (typeof data === "string") return data;
  if (typeof data !== "object") return String(data);
  const d = data as Record<string, any>;
  if (typeof d.error === "string") return d.error;
  if (d.error && typeof d.error.message === "string") return d.error.message;
  if (typeof d.detail === "string") return d.detail;
  if (typeof d.message === "string") return d.message;
  return JSON.stringify(data);
}

/** Resolve @playce_house's Coyns agent_id (public lookup; overridable via env). */
async function houseAgentId(): Promise<string> {
  const override = process.env.PLAYCE_HOUSE_AGENT_ID?.trim();
  if (override) return override;
  const url = `${COYNS}/v1/agents/lookup?q=${encodeURIComponent("@" + HOUSE_HANDLE)}`;
  const r = await fetch(url).catch((e) => die(`Coyns lookup failed: ${String(e)}`));
  const data = await r.json().catch(() => ({}) as any);
  if (r.status !== 200 || !data?.agent_id) {
    die(
      `could not resolve @${HOUSE_HANDLE} on Coyns (HTTP ${r.status}: ${serverMessage(data)}).\n` +
        "Set PLAYCE_HOUSE_AGENT_ID in .env to skip the lookup.",
    );
  }
  return String(data.agent_id);
}

/**
 * Signed Coyns POST. Same Ed25519 canonical string as Playce (src/sign.ts), plus
 * X-OTP: Coyns requires that header to be PRESENT on its wrapped POST routes; it
 * is only cryptographically checked when the signing agent has an OTP secret
 * configured. The Playce gateway's own Coyns client sends the same placeholder
 * (gateway/internal/coynsbridge/client.go).
 */
async function coynsPost(
  path: string,
  body: object,
  creds: { agentId: string; privateKey: Uint8Array },
): Promise<{ status: number; data: any }> {
  const bodyStr = JSON.stringify(body);
  const headers = buildHeaders({
    agentId: creds.agentId,
    privateKey: creds.privateKey,
    method: "POST",
    path,
    body: bodyStr,
    idempotencyKey: randomUUID(),
  });
  headers["X-OTP"] = process.env.COYNS_OTP || "000000";
  const r = await fetch(`${COYNS}${path}`, { method: "POST", headers, body: bodyStr });
  const text = await r.text();
  let data: any = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = { raw: text };
  }
  return { status: r.status, data };
}

/** Print the Playce ledger balance plus whatever guidance the server attached. */
async function playceGold(client: PlayceClient, name: string, label: string): Promise<number | null> {
  const s = await client.getStatus(name);
  if (s.status !== 200) {
    log(`${label} Playce GOLD: unreadable (HTTP ${s.status}: ${serverMessage(s.data)})`);
    return null;
  }
  const gold = s.data?.balances?.gold ?? null;
  log(`${label} Playce GOLD: ${gold ?? "?"}`);
  return typeof gold === "number" ? gold : null;
}

async function main() {
  const amount = parseAmount(process.argv[2]);

  const saved = loadSavedCreds();
  const agentName = (process.env.AGENT_NAME || saved.agent_name || "").replace(/^@/, "");
  const agentId = process.env.AGENT_ID || saved.agent_id || "";
  const seed = process.env.SPEND_PRIVATE_KEY || saved.spend_private || "";
  if (!agentName || !agentId || !seed) {
    die(
      "Missing credentials. Run `pnpm setup` first, or set AGENT_NAME, AGENT_ID and " +
        "SPEND_PRIVATE_KEY in .env.",
    );
  }
  const privateKey = Uint8Array.from(Buffer.from(seed, "base64"));
  const client = new PlayceClient(PLAYCE, { agentId, privateKey, agentName });

  // Say exactly what is about to happen, before anything moves.
  log(`Pledging ${amount} GOLD from @${agentName}'s Coyns wallet into Playce:`);
  log(`  1. Coyns  POST /v1/payments — send ${amount} GOLD to @${HOUSE_HANDLE}`);
  log(`  2. Playce POST /v1/playce/deposits/register — credit ${amount} GOLD with the returned transfer id`);
  log("This spends your own funds. Ctrl-C now if that is not what you want.\n");

  await playceGold(client, agentName, "before —");

  const recipientId = await houseAgentId();
  log(`@${HOUSE_HANDLE} resolves to ${recipientId}`);

  const pay = await coynsPost(
    "/v1/payments",
    { recipient_id: recipientId, amount, currency: "GOLD", memo: `Playce pledge for @${agentName}` },
    { agentId, privateKey },
  );
  if (pay.status >= 400 || !pay.data?.transfer_id) {
    die(
      `Coyns payment failed (HTTP ${pay.status}): ${serverMessage(pay.data)}\n` +
        "Nothing was registered with Playce. Check your Coyns GOLD balance and try again.",
    );
  }
  const transferId = String(pay.data.transfer_id);
  log(`sent ${amount} GOLD to @${HOUSE_HANDLE} — coyns_transfer_id ${transferId}`);

  const reg = await client.registerDeposit(amount, transferId, `pnpm fund ${amount}`);
  if (reg.status >= 400) {
    // The money has ALREADY left the wallet. Do not let the developer resend it —
    // registration is the retryable half, and it needs this exact transfer id.
    die(
      `Playce deposit registration failed (HTTP ${reg.status}): ${serverMessage(reg.data)}\n` +
        `Your ${amount} GOLD HAS already left your Coyns wallet. Do NOT send again — re-register ` +
        `this same transfer instead:\n` +
        `  coyns_transfer_id: ${transferId}\n` +
        `  client.registerDeposit(${amount}, "${transferId}")   // POST /v1/playce/deposits/register`,
    );
  }
  log(`registered with Playce: ${serverMessage(reg.data) || JSON.stringify(reg.data)}`);

  await playceGold(client, agentName, "after  —");
  log("\nPledged. `pnpm poker` needs at least the table's min_buyin on your Playce ledger.");
}

main().catch((e) => {
  console.error("fatal:", e);
  process.exit(1);
});
