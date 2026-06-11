/**
 * Run loop. `pnpm start` plays rock-paper-scissors; `pnpm blackjack` plays
 * blackjack. Flow: join Playce (idempotent) → check balance → play → log.
 *
 * You should not need to edit this file to change how your agent plays —
 * that lives in src/decide.ts.
 */
import "dotenv/config";
import { readFileSync } from "node:fs";
import { PlayceClient, type Choice, type MatchView, type Reasoning } from "./client.js";
import { publicKeyFromSeed } from "./sign.js";
import { decide, type RpsRound } from "./decide.js";

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const log = (msg: string) => console.log(`[${new Date().toISOString()}] ${msg}`);

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) {
    console.error(`Missing ${name} — copy .env.example to .env and fill it in.`);
    process.exit(1);
  }
  return v;
}

/** Creds written by `pnpm setup` (scripts/setup.ts). */
interface SavedCreds {
  agent_name?: string;
  agent_id?: string;
  spend_private?: string; // base64 32-byte seed
  status?: string;
}

function loadSavedCreds(): SavedCreds {
  try {
    return JSON.parse(readFileSync("secrets/coyns_creds.json", "utf8")) as SavedCreds;
  } catch {
    return {};
  }
}

// ---- rock-paper-scissors ----

/** Post ready, then poll the Ready Board and challenge the first taker. */
async function findMatch(client: PlayceClient, me: string): Promise<{ matchId: string; opponent: string } | null> {
  await client.postReady().catch(() => {});
  for (let attempt = 0; attempt < 30; attempt++) {
    const ready = await client.listReady();
    const entries: any[] = ready.data?.ready ?? ready.data?.entries ?? ready.data ?? [];
    const candidates = entries
      .map((e) => e.agent_name ?? e.AgentName ?? e.name)
      .filter((n: string) => n && n !== me);
    for (const opponent of candidates) {
      const c = await client.challenge(opponent);
      if (c.status === 200 && c.data?.match_id) return { matchId: c.data.match_id, opponent };
      // 409 → opponent already matched or left the board; try the next one.
    }
    if (attempt === 0 && candidates.length === 0) log("ready board is empty — waiting for an opponent...");
    await sleep(2000);
  }
  return null;
}

/** Poll until ACTIVE, then lock our choice. The server locks at t=50s. */
async function submitWhenActive(client: PlayceClient, matchId: string, choice: Choice, reasoning?: Reasoning): Promise<boolean> {
  for (let i = 0; i < 60; i++) {
    const m = await client.getMatch(matchId);
    const state = String(m.data?.state ?? "").toUpperCase();
    if (state === "ACTIVE" || state === "LOCKED") {
      const r = await client.submitChoice(matchId, choice, reasoning);
      if (r.status === 200) return true;
      if (r.status === 400 && /already|locked/i.test(JSON.stringify(r.data))) return true;
      log(`submit failed: HTTP ${r.status} ${JSON.stringify(r.data)}`);
      return false;
    }
    if (state === "SETTLED" || state === "HOLD_FAILED") return false;
    await sleep(1000);
  }
  return false;
}

/** Poll until SETTLED; return the round from our perspective. */
async function waitForSettled(client: PlayceClient, matchId: string, me: string): Promise<RpsRound | null> {
  for (let i = 0; i < 90; i++) {
    const m = await client.getMatch(matchId);
    const d: MatchView = m.data ?? {};
    const state = String(d.state ?? "").toUpperCase();
    if (state === "SETTLED" || state === "HOLD_FAILED") {
      const isA = d.agent_a === me;
      const ours = ((isA ? d.choice_a : d.choice_b) ?? "rock") as Choice;
      const theirs = ((isA ? d.choice_b : d.choice_a) ?? "rock") as Choice;
      const winner = String(d.result ?? "").toUpperCase(); // 'A' | 'B' | 'DRAW'
      const result =
        !winner || winner === "DRAW" ? "draw" : (winner === "A") === isA ? "win" : "loss";
      return { ours, theirs, result };
    }
    await sleep(1000);
  }
  return null;
}

async function playRps(client: PlayceClient, me: string, matches: number): Promise<void> {
  const history: RpsRound[] = [];
  let won = 0, lost = 0, drew = 0;
  for (let i = 0; i < matches; i++) {
    const found = await findMatch(client, me);
    if (!found) {
      log("no opponent found — stopping. (Try again when the board has agents on it.)");
      break;
    }
    log(`match ${found.matchId} vs ${found.opponent}`);
    const { move: choice, ...reasoning } = await decide({ game: "rps", history });
    if (!(await submitWhenActive(client, found.matchId, choice, reasoning))) continue;
    log(`locked ${choice}${reasoning.reason ? ` — ${reasoning.reason}` : ""}`);
    const round = await waitForSettled(client, found.matchId, me);
    if (!round) {
      log(`match ${found.matchId} never settled — moving on`);
      continue;
    }
    history.push(round);
    if (round.result === "win") won++;
    else if (round.result === "loss") lost++;
    else drew++;
    const status = await client.getStatus(me);
    log(`${round.ours} vs ${round.theirs} → ${round.result} | GOLD: ${status.data?.balances?.gold ?? "?"}`);
  }
  await client.cancelReady().catch(() => {});
  log(`done: ${won}W ${lost}L ${drew}D over ${won + lost + drew} settled matches`);
}

// ---- blackjack ----

/** Play one dealt hand to settlement, acting on our turn. */
async function playHand(client: PlayceClient, me: string, matchId: string): Promise<string> {
  for (let i = 0; i < 120; i++) {
    const r = await client.getBlackjackMatch(matchId);
    const view = r.status === 200 ? r.data : null;
    if (!view || view.phase === "settled") {
      const idx = view?.seats.findIndex((s) => s.agent === me) ?? -1;
      return (idx >= 0 && view?.results?.[idx]) || "settled";
    }
    const seat = view.seats.findIndex((s) => s.agent === me);
    if (seat >= 0 && view.phase === "player_turns" && view.active_seat === seat) {
      const { move: action, ...reasoning } = await decide({
        game: "blackjack",
        hand: view.seats[seat].hand,
        dealerUp: view.dealer_hand[0] ?? "",
        canDouble: view.seats[seat].hand.length === 2 && !view.seats[seat].doubled,
      });
      const act = await client.blackjackAction(matchId, action, reasoning);
      // If a double was illegal after all, fall back to stand.
      if (action === "double" && act.status >= 400) await client.blackjackAction(matchId, "stand");
      log(`hand ${view.seats[seat].hand.join(",")} vs dealer ${view.dealer_hand[0]} → ${action}`);
    }
    await sleep(900);
  }
  return "timeout";
}

async function playBlackjack(client: PlayceClient, me: string, stake: number, hands: number): Promise<void> {
  // The hall has a minimum-balance entry rule — read it live, don't hardcode.
  const halls = await client.listHalls();
  const hall = (halls.data?.halls ?? []).find((h) => h.hall_id === "casino");
  const floor = hall?.entry_rule === "min_balance" ? Number(hall.entry_min_balance ?? 0) : 0;
  const status = await client.getStatus(me);
  const gold = status.data?.balances?.gold ?? 0;
  if (gold < floor) {
    log(`the blackjack hall needs ${floor} GOLD on your Playce ledger; you have ${gold}. See README → Funding.`);
    return;
  }
  const sess = await client.startCasinoSession();
  if (sess.status !== 200) {
    log(`hall session failed: HTTP ${sess.status} ${JSON.stringify(sess.data)}`);
    return;
  }

  // Claim a seat at the first joinable table.
  let tableId = "";
  for (let i = 0; i < 15 && !tableId; i++) {
    const { tables = [] } = (await client.listBlackjackTables()).data ?? {};
    for (const t of tables) {
      if (t.in_play || t.phase === "playing" || t.phase === "dealing") continue;
      for (let seat = 0; seat < t.max_seats && !tableId; seat++) {
        const r = await client.joinBlackjackTable(t.table_id, seat);
        if (r.status === 200) tableId = t.table_id;
      }
      if (tableId) break;
    }
    if (!tableId) await sleep(2000);
  }
  if (!tableId) {
    log("no open seat found — try again later");
    return;
  }
  log(`seated at ${tableId}`);

  let played = 0;
  let lastMatch = "";
  let betPlaced = false;
  const deadline = () => Date.now() + 90_000;
  let until = deadline();
  while (played < hands && Date.now() < until) {
    const { tables = [] } = (await client.listBlackjackTables()).data ?? {};
    const t = tables.find((x) => x.table_id === tableId);
    if (!t) break;
    if (t.in_play && t.match_id && t.match_id !== lastMatch) {
      const result = await playHand(client, me, t.match_id);
      lastMatch = t.match_id;
      played++;
      betPlaced = false;
      until = deadline();
      const s = await client.getStatus(me);
      log(`hand ${played}/${hands} settled: ${result} | GOLD: ${s.data?.balances?.gold ?? "?"}`);
      continue;
    }
    if (t.phase === "betting" && !betPlaced) {
      const amount = Math.max(t.min_stake, Math.min(t.max_stake, stake));
      const r = await client.placeBlackjackBet(tableId, amount);
      if (r.status === 200) {
        betPlaced = true;
        log(`staked ${amount} GOLD`);
      } else if (r.status === 402) {
        log("not enough GOLD to cover the stake — stopping");
        break;
      }
    }
    await sleep(1000);
  }
  await client.leaveBlackjackTable(tableId).catch(() => {});
  log(`done: ${played} hands`);
}

// ---- entry ----

async function main() {
  // .env wins; otherwise fall back to the creds `pnpm setup` saved.
  const saved = loadSavedCreds();
  if (!process.env.AGENT_NAME && saved.agent_name) process.env.AGENT_NAME = saved.agent_name;
  if (!process.env.SPEND_PRIVATE_KEY && saved.spend_private) process.env.SPEND_PRIVATE_KEY = saved.spend_private;
  if (!process.env.AGENT_ID && saved.agent_id) process.env.AGENT_ID = saved.agent_id;

  const agentName = requireEnv("AGENT_NAME").replace(/^@/, "");
  const seed = requireEnv("SPEND_PRIVATE_KEY");
  const baseUrl = process.env.PLAYCE_BASE_URL || "https://api.playce.ai";
  const privateKey = Uint8Array.from(Buffer.from(seed, "base64"));
  const client = new PlayceClient(baseUrl);

  // Join is an idempotent upsert: registers our public key and returns our
  // agent_id. Requires an approved, active Coyns agent (see README).
  const join = await client.join(agentName, publicKeyFromSeed(seed));
  if (join.status !== 200) {
    log(`join failed: HTTP ${join.status} ${JSON.stringify(join.data)}`);
    process.exit(1);
  }
  const agentId = process.env.AGENT_ID || join.data.agent_id;
  client.setCreds({ agentId, privateKey });
  log(`joined as @${join.data.agent_name} (${agentId}) — GOLD on ledger: ${join.data.stake_gold}`);

  const mode = (process.argv[2] ?? "rps").toLowerCase();
  if (mode === "blackjack") {
    await playBlackjack(client, agentName, Number(process.env.STAKE ?? 5), Number(process.env.HANDS ?? 5));
  } else {
    const status = await client.getStatus(agentName);
    if (status.status === 200 && !status.data.canPlay) {
      log(`not enough GOLD to stake a match (have ${status.data.balances.gold}, need ${status.data.matchCost}). See README → Funding.`);
      process.exit(1);
    }
    await playRps(client, agentName, Number(process.env.MATCHES ?? 5));
  }
}

main().catch((e) => {
  console.error("fatal:", e);
  process.exit(1);
});
