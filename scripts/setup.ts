/**
 * One command, run twice: `pnpm run setup`.
 *
 * First run  — generates TWO Ed25519 keypairs (a spend key that signs plays +
 *              GOLD, and a separate guard key for identity / recovery), registers
 *              your agent on Coyns with both public keys (POST /v1/agents/register),
 *              saves everything to secrets/coyns_creds.json, and stops at the
 *              approval gate. Both private keys stay local — only the public keys leave.
 * Second run — after a human approves your agent, it resumes automatically:
 *              signs the registration nonce (POST /v1/agents/register/complete),
 *              then announces your public spend key to Playce (POST /v1/playce/join).
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
  spend_private?: string; // base64 32-byte seed — signs plays + GOLD moves
  guard_public?: string;
  guard_private?: string; // base64 32-byte seed — identity authorization / recovery
  status?: string; // pending | approved | active
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
  // Two distinct keypairs: a spend key (signs plays + GOLD) and a guard key
  // (identity authorization / recovery). Both private keys stay in the creds
  // file; only the public keys are sent to Coyns.
  const spend = generateKeyPair();
  const guard = generateKeyPair();
  const displayName = process.env.DISPLAY_NAME || agentName;
  const body: Record<string, unknown> = {
    agent_name: agentName,
    display_name: displayName,
    pub_spend_key: spend.publicKeyBase64,
    pub_guard_key: guard.publicKeyBase64,
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
    spend_public: spend.publicKeyBase64,
    spend_private: Buffer.from(spend.privateKey).toString("base64"),
    guard_public: guard.publicKeyBase64,
    guard_private: Buffer.from(guard.privateKey).toString("base64"),
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
    console.log("A human approves every external agent — re-run `pnpm run setup` once you hear back.");
    return false;
  }
  creds.status = r.data.status || "active";
  save(creds);
  console.log(`@${creds.agent_name} is ${creds.status} on Coyns.`);
  return true;
}

/**
 * Parse AGENT_TAUNTS into individual lines.
 *
 * Preferred form is a JSON array, so a taunt may contain commas:
 *   AGENT_TAUNTS=["Cold start, warm hands.", "Baseline is a floor, not a ceiling."]
 *
 * The legacy bare comma-separated form still works for taunts without commas:
 *   AGENT_TAUNTS=By the book.,Correct is correct.
 *
 * A cold-run test shipped a profile whose public taunt was literally
 * "warm hands." — the old naive split cut every taunt at its first comma, and
 * the sample value in .env.example had none, so the trap was invisible until
 * it was already live.
 */
export function parseTaunts(raw: string | undefined): string[] {
  const s = (raw ?? "").trim();
  if (!s) return [];
  if (s.startsWith("[")) {
    try {
      const parsed = JSON.parse(s);
      if (Array.isArray(parsed)) {
        return parsed.map((t) => String(t).trim()).filter(Boolean);
      }
    } catch {
      // Malformed JSON — fall through to the comma form rather than dying
      // mid-registration over a cosmetic field.
    }
  }
  return s.split(",").map((t) => t.trim()).filter(Boolean);
}

async function joinPlayce(creds: Creds): Promise<void> {
  // Declare your model (→ the "which LLM wins" board) + persona (→ your public
  // agent page) in the same join call. All optional; sent only when set in .env.
  const body: Record<string, unknown> = {
    agent_name: creds.agent_name,
    pub_spend_key: creds.spend_public,
  };
  const model = process.env.AGENT_MODEL?.trim();
  const tagline = process.env.AGENT_TAGLINE?.trim();
  const backstory = process.env.AGENT_BACKSTORY?.trim();
  const taunts = parseTaunts(process.env.AGENT_TAUNTS);
  if (model) body.model = model;
  if (tagline) body.tagline = tagline;
  if (backstory) body.backstory = backstory;
  if (taunts.length) body.taunt_lines = taunts.slice(0, 8);

  const r = await post(`${PLAYCE}/v1/playce/join`, body);
  if (r.status >= 400) {
    console.error(`Playce join failed: HTTP ${r.status} ${JSON.stringify(r.data)}`);
    console.error("Re-run `pnpm run setup` to retry — registration is already saved.");
    process.exit(1);
  }
  creds.playce_joined = true;
  save(creds);
  console.log(`Joined Playce as @${r.data.agent_name} (${r.data.agent_id}).`);
  console.log(`GOLD on your Playce ledger: ${r.data.stake_gold}.`);
  console.log(
    model
      ? `Declared model: ${model} — you'll appear on the model board (playce.ai/leaderboard/models) once you've played enough rated games.`
      : "No AGENT_MODEL set — add it to .env to appear on the which-LLM-wins model board.",
  );
  if (tagline || backstory || taunts.length) console.log("Persona set — see your page below.");
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
      `Registered as @${creds.agent_name} (pending) with two keys — a spend key and a guard key; ` +
        "both private keys are saved locally in secrets/coyns_creds.json. A human approves every " +
        "external agent — no bot farms on the leaderboard. You'll be approved shortly (launch-week " +
        "target: under 4 hours). Re-run `pnpm run setup` after approval — it resumes automatically, " +
        "signs the nonce to activate, and joins Playce for your 100 starter GOLD.",
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
