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
import { pathToFileURL } from "node:url";
import * as ed from "@noble/ed25519";
import { generateKeyPair } from "../src/sign.js"; // also installs the sha512 shim on `ed`
import { cmd } from "../src/pm.js";

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
  /** The FULL Coyns register response. Kept (not discarded down to agent_id +
   *  nonce) so any referral/founder reward it reported can still be shown on
   *  the second, post-approval run — the run whose output the developer
   *  actually reads. */
  register_response?: Record<string, unknown>;
}

function load(): Creds | null {
  if (!existsSync(CREDS_PATH)) return null;
  return JSON.parse(readFileSync(CREDS_PATH, "utf8")) as Creds;
}

function save(c: Creds) {
  mkdirSync("secrets", { recursive: true });
  writeFileSync(CREDS_PATH, JSON.stringify(c, null, 2));
}

async function get(url: string): Promise<{ status: number; data: any }> {
  const r = await fetch(url).catch(() => null);
  if (!r) return { status: 0, data: {} };
  const data = await r.json().catch(() => ({}));
  return { status: r.status, data };
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

/**
 * Keys that carry a signup/referral reward in a Coyns register or
 * register/complete response. REFERRAL_CODE=founders500 really does pay — a
 * cold-run test was credited 610 GOLD — but it lands in the agent's COYNS
 * WALLET, and the kit used to throw the whole response away except agent_id and
 * nonce. The developer then saw only "GOLD on your Playce ledger: 100", sat
 * exactly on the casino floor, and was locked out of poker (min buy-in 100)
 * with no idea a bonus existed. Match on a pattern rather than a fixed list so
 * a field Coyns renames or adds still gets surfaced.
 */
const REWARD_KEY = /founder|referral|welcome|reward|bonus|grant|credit|coyns_delta/i;

export interface Reward {
  key: string;
  value: unknown;
}

/** Collect reward-ish fields from a response body (top level + one level deep). */
export function extractRewards(data: unknown, depth = 1): Reward[] {
  if (!data || typeof data !== "object" || Array.isArray(data)) return [];
  const out: Reward[] = [];
  for (const [key, value] of Object.entries(data as Record<string, unknown>)) {
    if (value === null || value === undefined || value === "" || value === false) continue;
    if (REWARD_KEY.test(key)) {
      out.push({ key, value });
      continue;
    }
    if (depth > 0 && typeof value === "object" && !Array.isArray(value)) {
      out.push(...extractRewards(value, depth - 1).map((r) => ({ key: `${key}.${r.key}`, value: r.value })));
    }
  }
  return out;
}

/** Print any reward the server reported, and say WHERE it landed. */
function printRewards(rewards: Reward[]): void {
  if (!rewards.length) return;
  console.log("\nCoyns reported a signup reward:");
  for (const r of rewards) {
    console.log(`  ${r.key}: ${typeof r.value === "object" ? JSON.stringify(r.value) : String(r.value)}`);
  }
  console.log(
    "That reward is in your COYNS WALLET — a different ledger from Playce. It is NOT spendable at " +
      "Playce until you pledge it (see the pledge hint at the end of setup).",
  );
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
    register_response: r.data && typeof r.data === "object" ? r.data : undefined,
  };
  save(creds);
  if (process.env.REFERRAL_CODE) {
    console.log(`Sent referral code ${process.env.REFERRAL_CODE} with your registration.`);
  }
  printRewards(extractRewards(r.data));
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
    console.log(`A human approves every external agent — re-run \`${cmd("setup")}\` once you hear back.`);
    return false;
  }
  creds.status = r.data.status || "active";
  save(creds);
  console.log(`@${creds.agent_name} is ${creds.status} on Coyns.`);
  // Activation is the other place a referral/founder reward can be reported —
  // don't discard this response either.
  printRewards(extractRewards(r.data));
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
    console.error(`Re-run \`${cmd("setup")}\` to retry — registration is already saved.`);
    process.exit(1);
  }
  creds.playce_joined = true;
  save(creds);
  console.log(`Joined Playce as @${r.data.agent_name} (${r.data.agent_id}).`);
  console.log(
    model
      ? `Declared model: ${model} — you'll appear on the model board (playce.ai/leaderboard/models) once you've played enough rated games.`
      : "No AGENT_MODEL set — add it to .env to appear on the which-LLM-wins model board.",
  );
  if (tagline || backstory || taunts.length) console.log("Persona set — see your page below.");

  // Re-show any reward from registration: the first run's output has long since
  // scrolled past, and this is the run the developer reads before playing.
  printRewards(extractRewards(creds.register_response));

  await printMoney(creds, Number(r.data.stake_gold ?? 0));

  console.log(`\nNext: \`${cmd("start")}\` plays rock-paper-scissors; \`${cmd("blackjack")}\` plays blackjack; \`${cmd("poker")}\` plays hold'em.`);
  console.log(`Your public record: https://playce.ai/agent/${creds.agent_name}`);
}

/**
 * The money block — the part a cold-run developer misread.
 *
 * Playce GOLD is only what you have PLEDGED from your Coyns wallet, and the two
 * ledgers are separate: a founders500/referral bonus lands in the WALLET and is
 * invisible here until pledged. Printing "GOLD on your Playce ledger: 100" and
 * nothing else reads as "100 is all I have", which parks the agent exactly on
 * the casino floor and silently locks it out of poker (min buy-in 100).
 *
 * The gateway now writes this guidance itself (`funding_note` / `coyns_note` on
 * GET .../status), so echo the server's text and never invent a wallet number —
 * Playce cannot see the Coyns wallet, so neither can this script.
 */
async function printMoney(creds: Creds, joinGold: number): Promise<void> {
  const s = await get(`${PLAYCE}/v1/playce/agents/${creds.agent_name}/status`);
  const balances = s.status === 200 ? (s.data?.balances ?? {}) : {};
  const gold = typeof balances.gold === "number" ? balances.gold : joinGold;

  console.log(`\nGOLD on your Playce ledger: ${gold}`);
  const code = process.env.REFERRAL_CODE?.trim();
  console.log(
    code
      ? `Your ${code} bonus (if any) lands in your COYNS WALLET — not spendable at Playce until you pledge it.`
      : "Any Coyns signup/referral bonus lands in your COYNS WALLET — not spendable at Playce until you pledge it.",
  );
  for (const note of [balances.funding_note, balances.coyns_note]) {
    if (typeof note === "string" && note) console.log(`  ${note}`);
  }
  console.log(`Check your wallet + pledge:  ${cmd("fund")} <amount>`);
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
        "external agent — no bot farms on the leaderboard. Approval is usually minutes: it is a " +
        `person, not a queue. Re-run \`${cmd("setup")}\` once approved — it resumes automatically, ` +
        "signs the nonce to activate, and joins Playce for your 100 starter GOLD.",
    );
    return;
  }

  if (creds.status !== "active") {
    if (!(await complete(creds))) return;
  }
  await joinPlayce(creds);
}

// Same direct-execution guard as src/index.ts: run the flow for `pnpm setup`,
// but stay inert when this module is imported for its exported helpers
// (parseTaunts / extractRewards, covered by test/setup.test.ts). pathToFileURL,
// not `file://${argv[1]}` — on Windows the template form never matches
// import.meta.url, which is how the kit was once silently dead on Windows.
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((e) => {
    console.error("fatal:", e);
    process.exit(1);
  });
}
