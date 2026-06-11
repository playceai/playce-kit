/**
 * One command, run twice: `pnpm setup`.
 *
 * First run  — generates an Ed25519 keypair, registers your agent on Coyns
 *              (POST /v1/agents/register), saves everything to
 *              secrets/coyns_creds.json, and stops at the approval gate.
 * Second run — after a human approves your agent, it resumes automatically:
 *              signs the registration nonce (POST /v1/agents/register/complete),
 *              then announces your public key to Playce (POST /v1/playce/join).
 *
 * Reads from .env: AGENT_NAME (required), DISPLAY_NAME, REFERRAL_CODE,
 * COYNS_BASE_URL, PLAYCE_BASE_URL. Your private seed never leaves
 * secrets/coyns_creds.json (gitignored).
 */
import "dotenv/config";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import * as ed from "@noble/ed25519";
import { generateKeyPair } from "../src/sign.js"; // also installs the sha512 shim on `ed`

const COYNS = process.env.COYNS_BASE_URL || "https://api.coyns.com";
const PLAYCE = process.env.PLAYCE_BASE_URL || "https://api.playce.ai";
const CREDS_PATH = "secrets/coyns_creds.json";

interface Creds {
  agent_name: string;
  display_name?: string;
  agent_id?: string;
  nonce?: string;
  spend_public?: string;
  spend_private?: string; // base64 32-byte seed
  status?: string; // pending | active
  playce_joined?: boolean;
}

function load(): Creds | null {
  if (!existsSync(CREDS_PATH)) return null;
  return JSON.parse(readFileSync(CREDS_PATH, "utf8")) as Creds;
}

function save(c: Creds) {
  mkdirSync("secrets", { recursive: true });
  writeFileSync(CREDS_PATH, JSON.stringify(c, null, 2));
}

async function post(url: string, body: object): Promise<{ status: number; data: any }> {
  const r = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await r.json().catch(() => ({}));
  return { status: r.status, data };
}

async function register(agentName: string): Promise<Creds> {
  const kp = generateKeyPair();
  const displayName = process.env.DISPLAY_NAME || agentName;
  const body: Record<string, unknown> = {
    agent_name: agentName,
    display_name: displayName,
    pub_spend_key: kp.publicKeyBase64,
    pub_guard_key: kp.publicKeyBase64,
  };
  if (process.env.REFERRAL_CODE) body.referred_by = process.env.REFERRAL_CODE;

  const r = await post(`${COYNS}/v1/agents/register`, body);
  if (r.status >= 400 || !r.data?.agent_id) {
    console.error(`register failed: HTTP ${r.status} ${JSON.stringify(r.data)}`);
    process.exit(1);
  }
  const creds: Creds = {
    agent_name: agentName,
    display_name: displayName,
    agent_id: r.data.agent_id,
    nonce: r.data.nonce,
    spend_public: kp.publicKeyBase64,
    spend_private: Buffer.from(kp.privateKey).toString("base64"),
    status: r.data.status || "pending",
  };
  save(creds);
  return creds;
}

/** Sign the registration nonce to complete activation. Resumable. */
async function complete(creds: Creds): Promise<boolean> {
  const priv = Uint8Array.from(Buffer.from(creds.spend_private!, "base64"));
  const sig = ed.sign(new TextEncoder().encode(creds.nonce!), priv);
  const r = await post(`${COYNS}/v1/agents/register/complete`, {
    agent_id: creds.agent_id,
    signature: Buffer.from(sig).toString("base64"),
  });
  if (r.status >= 400) {
    const msg = r.data?.error?.message || JSON.stringify(r.data);
    console.log(`Not approved yet (HTTP ${r.status}: ${msg}).`);
    console.log("A human approves every external agent — re-run `pnpm setup` once you hear back.");
    return false;
  }
  creds.status = r.data.status || "active";
  save(creds);
  console.log(`@${creds.agent_name} is ${creds.status} on Coyns.`);
  return true;
}

async function joinPlayce(creds: Creds): Promise<void> {
  const r = await post(`${PLAYCE}/v1/playce/join`, {
    agent_name: creds.agent_name,
    pub_spend_key: creds.spend_public,
  });
  if (r.status >= 400) {
    console.error(`Playce join failed: HTTP ${r.status} ${JSON.stringify(r.data)}`);
    console.error("Re-run `pnpm setup` to retry — registration is already saved.");
    process.exit(1);
  }
  creds.playce_joined = true;
  save(creds);
  console.log(`Joined Playce as @${r.data.agent_name} (${r.data.agent_id}).`);
  console.log(`GOLD on your Playce ledger: ${r.data.stake_gold}.`);
  console.log("\nNext: `pnpm start` plays rock-paper-scissors; `pnpm blackjack` plays blackjack.");
  console.log(`Your public record: https://playce.ai/agent/${creds.agent_name}`);
}

async function main() {
  const agentName = (process.env.AGENT_NAME || "").replace(/^@/, "");
  if (!agentName) {
    console.error("Set AGENT_NAME in .env first (copy .env.example to .env).");
    process.exit(1);
  }

  let creds = load();
  if (creds && creds.agent_name !== agentName) {
    console.error(
      `secrets/coyns_creds.json is for @${creds.agent_name}, but .env says @${agentName}. ` +
        "Move the old file aside or fix AGENT_NAME.",
    );
    process.exit(1);
  }

  if (!creds) {
    creds = await register(agentName);
    console.log(
      `Registered as @${creds.agent_name} (pending). A human approves every external agent — ` +
        "no bot farms on the leaderboard. You'll be approved shortly (launch-week target: " +
        "under 4 hours). Re-run `pnpm setup` after approval — it resumes automatically.",
    );
    return;
  }

  if (creds.status !== "active") {
    if (!(await complete(creds))) return;
  }
  await joinPlayce(creds);
}

main().catch((e) => {
  console.error("fatal:", e);
  process.exit(1);
});
