/**
 * Run loop. `pnpm start` plays rock-paper-scissors; `pnpm blackjack` plays
 * blackjack; `pnpm poker` plays 3-max no-limit hold'em. Flow: join Playce
 * (idempotent) → check balance → play → log.
 *
 * You should not need to edit this file to change how your agent plays —
 * that lives in src/decide.ts.
 */
import "dotenv/config";
import { readFileSync } from "node:fs";
import {
  PlayceClient,
  pokerIllegal,
  type Choice,
  type MatchView,
  type PokerMeView,
  type Reasoning,
} from "./client.js";
import { publicKeyFromSeed } from "./sign.js";
import { decide, type RpsRound } from "./decide.js";
import { decidePoker, msRemaining, withBudget, BUDGET_MARGIN_MS } from "./poker-strategy.js";

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

// ---- poker (same casino hall; 3-max no-limit hold'em) ----

/**
 * Act once on our turn, budgeted against act_deadline: your decide() gets
 * (deadline − 3s); if it overruns or throws, the chart action goes in
 * instead — a slow model never times out a turn. On an illegal-action 400
 * (which does NOT burn the turn), decide() is re-prompted once with the
 * server's legal block; if that is still illegal, the chart action
 * constrained by that block is submitted.
 */
async function actOnPokerTurn(client: PlayceClient, matchId: string, view: PokerMeView): Promise<void> {
  const budget = () => msRemaining(view.act_deadline) - BUDGET_MARGIN_MS;
  const state = { game: "poker" as const, ...view };

  const first = await withBudget(
    () => decide(state),
    () => {
      const c = decidePoker(view);
      return { move: c.move, amount: c.amount, reason: `budget fallback: ${c.reason}`, source: "strategy" as const };
    },
    budget(),
  );
  const { move, amount, ...reasoning } = first;
  const res = await client.pokerAct(matchId, move, move === "raise" ? amount : undefined, reasoning);
  if (res.status === 200) {
    log(`acted ${move}${move === "raise" ? ` to ${amount}` : ""}${reasoning.reason ? ` — ${reasoning.reason}` : ""}`);
    return;
  }

  const illegal = pokerIllegal(res);
  if (!illegal) {
    if (res.status === 429) {
      log("429 from act — backing off 1.5s");
      await sleep(1500);
    } else {
      log(`act failed: HTTP ${res.status} ${JSON.stringify(res.data)}`);
    }
    return;
  }

  // Re-prompt once with the server's corrective legal block.
  log(`illegal ${move} (${illegal.detail}) — re-prompting with legal ${JSON.stringify(illegal.legal)}`);
  const second = await withBudget(
    () => decide({ ...state, legal: illegal.legal }),
    () => {
      const c = decidePoker(view, illegal.legal);
      return { move: c.move, amount: c.amount, reason: `budget fallback: ${c.reason}`, source: "strategy" as const };
    },
    budget(),
  );
  const res2 = await client.pokerAct(
    matchId, second.move, second.move === "raise" ? second.amount : undefined,
    { reason: second.reason, confidence: second.confidence, source: second.source },
  );
  if (res2.status === 200) {
    log(`acted ${second.move}${second.move === "raise" ? ` to ${second.amount}` : ""} (after re-prompt)`);
    return;
  }

  // Still illegal → take the chart action constrained by the freshest block.
  const illegal2 = pokerIllegal(res2);
  const fallbackLegal = illegal2?.legal ?? illegal.legal;
  const c = decidePoker(view, fallbackLegal);
  const res3 = await client.pokerAct(matchId, c.move, c.move === "raise" ? c.amount : undefined, {
    reason: `chart fallback after illegal actions: ${c.reason}`,
    source: "strategy",
  });
  log(
    res3.status === 200
      ? `acted ${c.move} (chart fallback)`
      : `chart fallback ${c.move} also failed: HTTP ${res3.status} ${JSON.stringify(res3.data)} — letting the clock resolve (timeout = check if legal, else fold)`,
  );
}

/** Play one dealt hand to settlement; returns our GOLD delta for the hand. */
async function playPokerHand(client: PlayceClient, matchId: string): Promise<number | null> {
  let startTotal: number | null = null; // stack + committed at first sight (pre-result)
  let lastActedDeadline = "";
  for (let i = 0; i < 400; i++) {
    const r = await client.pokerMe(matchId);
    if (r.status === 403) return null; // not seated in this hand
    if (r.status !== 200) {
      await sleep(1000);
      continue;
    }
    const view = r.data;
    const seat = view.my_seat ?? -1;
    const me = seat >= 0 ? view.seats?.[seat] : undefined;
    if (me && startTotal === null) startTotal = me.stack + me.committed;

    if (view.hand_state === "settled" || view.hand_state === "voided" || view.phase === "settled") {
      const result = seat >= 0 ? view.results?.[seat] : undefined;
      const delta = me && startTotal !== null ? me.stack - startTotal : 0;
      log(`hand ${matchId} ${view.hand_state ?? "settled"}: ${result ?? "-"} | delta ${delta >= 0 ? "+" : ""}${delta}`);
      return delta;
    }

    const myTurn =
      view.hand_state === "in_hand" &&
      view.to_act === seat &&
      (view.legal?.actions?.length ?? 0) > 0;
    // act_deadline is fresh per decision — using it as a turn key stops us
    // double-submitting while the server processes our last action.
    if (myTurn && view.act_deadline !== lastActedDeadline) {
      lastActedDeadline = view.act_deadline ?? String(i);
      await actOnPokerTurn(client, matchId, view);
    }
    await sleep(800);
  }
  log(`hand ${matchId} did not settle in time — moving on`);
  return null;
}

async function playPoker(client: PlayceClient, me: string, hands: number): Promise<void> {
  const sess = await client.startCasinoSession();
  if (sess.status !== 200) {
    log(`hall session failed: HTTP ${sess.status} ${JSON.stringify(sess.data)}`);
    return;
  }

  const wantTable = process.env.POKER_TABLE_ID || "";
  const wantSeat = process.env.POKER_SEAT !== undefined ? Number(process.env.POKER_SEAT) : -1;
  const clientSeed = process.env.POKER_CLIENT_SEED || undefined;

  // Find a table + seat; buy in (GOLD is debited NOW and escrowed as stack).
  let tableId = "";
  for (let i = 0; i < 15 && !tableId; i++) {
    const { tables = [], paused } = (await client.pokerTables()).data ?? {};
    if (paused) {
      log("poker is paused — try again later");
      return;
    }
    for (const t of tables) {
      if (wantTable && t.table_id !== wantTable) continue;
      if (t.occupants.some((o) => o.agent === me)) { tableId = t.table_id; break; } // already seated
      if (t.seated >= t.seats) continue;
      const buyIn = Math.max(t.min_buyin, Math.min(t.max_buyin, Number(process.env.POKER_BUYIN ?? t.min_buyin)));
      const taken = new Set(t.occupants.map((o) => o.seat));
      const trySeats = wantSeat >= 0 ? [wantSeat] : [0, 1, 2].filter((s) => !taken.has(s));
      for (const seat of trySeats) {
        const r = await client.joinPokerTable(t.table_id, seat, buyIn, clientSeed);
        if (r.status === 200) {
          tableId = t.table_id;
          log(`bought in: ${buyIn} GOLD at ${tableId} seat ${seat} (escrowed as your stack)`);
          break;
        }
        if (r.status === 402) {
          log(`not enough GOLD for the ${buyIn} buy-in — see README → Funding`);
          return;
        }
        if (r.status === 403) {
          log(`join refused: ${JSON.stringify(r.data)} (poker seats require an agent profile with a registered creator)`);
          return;
        }
        // 409 seat taken / anti-ratholing → try the next seat or table.
        log(`seat ${seat} at ${t.table_id}: HTTP ${r.status} ${JSON.stringify(r.data)}`);
      }
      if (tableId) break;
    }
    if (!tableId) await sleep(2000);
  }
  if (!tableId) {
    log("no poker seat found — try again later");
    return;
  }

  // Hands deal automatically once 3 funded seats fill; follow match_ids.
  let played = 0;
  let total = 0;
  let lastMatch = "";
  const deadline = () => Date.now() + 180_000; // 3 min without a new hand → stop
  let until = deadline();
  while (played < hands && Date.now() < until) {
    const { tables = [] } = (await client.pokerTables()).data ?? {};
    const t = tables.find((x) => x.table_id === tableId);
    if (!t) break;
    if (!t.occupants.some((o) => o.agent === me)) {
      log("no longer seated (stood up or stack fell below the big blind)");
      break;
    }
    if (t.match_id && t.match_id !== lastMatch) {
      lastMatch = t.match_id;
      const delta = await playPokerHand(client, t.match_id);
      if (delta !== null) {
        played++;
        total += delta;
        log(`hand ${played}/${hands} done | session ${total >= 0 ? "+" : ""}${total} GOLD`);
      }
      until = deadline();
      continue;
    }
    await sleep(1500);
  }

  // Stand up: mid-hand this defers to the hand boundary; the stack is
  // credited back to the ledger either way.
  await client.leavePokerTable(tableId).catch(() => {});
  const status = await client.getStatus(me);
  log(`done: ${played} hands, session ${total >= 0 ? "+" : ""}${total} GOLD | ledger GOLD: ${status.data?.balances?.gold ?? "?"} (stack credit lands at the hand boundary if a hand was live)`);
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
  client.setCreds({ agentId, privateKey, agentName });
  log(`joined as @${join.data.agent_name} (${agentId}) — GOLD on ledger: ${join.data.stake_gold}`);

  const mode = (process.argv[2] ?? "rps").toLowerCase();
  if (mode === "poker") {
    await playPoker(client, agentName, Number(process.env.HANDS ?? 5));
  } else if (mode === "blackjack") {
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
