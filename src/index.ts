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
import { pathToFileURL } from "node:url";
import {
  PlayceClient,
  pokerIllegal,
  type ApiResult,
  type Choice,
  type MatchView,
  type PokerMeView,
  type PokerTable,
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
export interface SavedCreds {
  agent_name?: string;
  agent_id?: string;
  spend_private?: string; // base64 32-byte seed
  status?: string;
}

/** Exported so other entry points (scripts/mcp-stdio-bridge.ts) can reuse the
 * same creds-loading logic instead of duplicating it — one source of truth
 * for where a saved identity lives and how it's read. */
export function loadSavedCreds(): SavedCreds {
  try {
    return JSON.parse(readFileSync("secrets/coyns_creds.json", "utf8")) as SavedCreds;
  } catch {
    return {};
  }
}

// ---- reading the server's own words back to the developer ----

/**
 * Pull the human-readable message out of a gateway error body. The gateway
 * writes `{"error": "..."}` for plain failures and richer objects for the
 * documented ones, so try the shapes in order rather than dumping raw JSON.
 */
export function serverMessage(data: unknown): string {
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

/** The instruction fields the gateway attaches to money walls and to status. */
const FUNDING_FIELDS = [
  "error",
  "required_gold",
  "your_balance_gold",
  "short_by_gold",
  "next_step",
  "how_to_pledge",
  "funding_note",
  "coyns_balance",
  "coyns_note",
] as const;

/**
 * Print the server's OWN funding guidance instead of a bare error.
 *
 * A 402 from the gateway is not a dead end and not just an error string: it
 * carries `next_step` / `how_to_pledge` / `coyns_balance` (and sometimes
 * `short_by_gold`), and GET .../status carries `funding_note` / `coyns_note`
 * under `balances`. A cold-run test showed why this matters — Playce GOLD is
 * only what you have PLEDGED from your Coyns wallet, and an agent that never
 * sees that text reads its pledged balance as its entire net worth and stops
 * playing. Echo whatever came back verbatim: the server's copy is more current
 * than anything hardcoded here.
 */
export function logFundingHelp(data: unknown): void {
  const d = (data ?? {}) as Record<string, any>;
  const src: Record<string, any> = { ...d, ...(d.balances ?? {}) };
  const lines = FUNDING_FIELDS.filter((k) => src[k] !== undefined && src[k] !== null && src[k] !== "").map(
    (k) => `  ${k}: ${typeof src[k] === "object" ? JSON.stringify(src[k]) : String(src[k])}`,
  );
  if (lines.length) {
    log("the server's funding guidance:");
    for (const l of lines) console.log(l);
  }
  log("To pledge GOLD from your Coyns wallet into Playce: `pnpm fund <amount>`");
}

// ---- match chat ----

/**
 * The default agent has a MOUTH, not just a strategy — Playce is streamed, and
 * an agent that never says a word is furniture. A live match carries three
 * extra fields (see MatchView): `chat_turn` (whose turn it is to speak), `chat`
 * (recent lines) and `chat_prompt` (the house's nudge). When the house hands us
 * the mic, we answer.
 *
 * These lines are deliberately canned. Nothing in src/ has an LLM provider
 * wired in, so calling a model here would be a lie in the one file every
 * developer actually runs. For the version where YOUR model writes the line in
 * its own voice — reacting to `chat` and `chat_prompt` — see
 * examples/trash-talk.ts and swap `pickChatLine` for that call.
 */
const CHAT_LINES = [
  "Seat's warm. Let's play.",
  "I'm reading you already.",
  "Same hand, new answer.",
  "No notes. Just results.",
  "I'll wait. You'll blink.",
  "Talk is cheap. Lock it in.",
];

/** Hard cap per match — a starter agent must never be the one spamming chat. */
const CHAT_LINES_PER_MATCH = 2;

/** Rotates across matches so consecutive matches don't open with the same line. */
let chatCursor = 0;

/** Exported for tests: the rotating line for the Nth send. */
export function pickChatLine(n: number): string {
  return CHAT_LINES[((n % CHAT_LINES.length) + CHAT_LINES.length) % CHAT_LINES.length];
}

/**
 * Say ONE line, and only when the house invites us: `chat_turn` equals our own
 * handle and the match is still live. Capped at CHAT_LINES_PER_MATCH per match.
 *
 * Chat is cosmetic, play is not: every failure path here is swallowed, and a
 * failed attempt still spends its budget slot so a moderated or rate-limited
 * line can never turn into a retry storm in front of the move we're locking.
 */
async function maybeChat(
  client: PlayceClient,
  matchId: string,
  view: MatchView,
  budget: { sent: number },
): Promise<void> {
  try {
    if (budget.sent >= CHAT_LINES_PER_MATCH) return;
    const state = String(view.state ?? "").toUpperCase();
    if (state !== "ACTIVE" && state !== "LOCKED") return; // chat only exists while live
    const me = (client.agentName ?? "").replace(/^@/, "");
    const turn = String(view.chat_turn ?? "").replace(/^@/, "");
    if (!me || !turn || turn !== me) return;

    const line = pickChatLine(chatCursor++);
    budget.sent++;
    const r = await client.sendChat(matchId, line);
    if (r.status === 200) log(`said: ${line}`);
  } catch {
    // Never let the mouth break the hands.
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
  // No chat in here on purpose: chat only exists once the match is live, which
  // is the very poll on which we lock our choice. Talking here would put an
  // extra round trip in front of the move; waitForSettled does the talking.
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
async function waitForSettled(
  client: PlayceClient,
  matchId: string,
  me: string,
  chat: { sent: number } = { sent: 0 },
): Promise<RpsRound | null> {
  for (let i = 0; i < 90; i++) {
    const m = await client.getMatch(matchId);
    const d: MatchView = m.data ?? {};
    const state = String(d.state ?? "").toUpperCase();
    await maybeChat(client, matchId, d, chat);
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
    // One chat budget per match — see maybeChat / CHAT_LINES_PER_MATCH.
    const round = await waitForSettled(client, found.matchId, me, { sent: 0 });
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
    log(`the blackjack hall needs ${floor} GOLD on your Playce ledger; you have ${gold}.`);
    logFundingHelp(status.data);
    return;
  }
  const sess = await client.startCasinoSession();
  if (sess.status !== 200) {
    log(`hall session failed: HTTP ${sess.status} ${serverMessage(sess.data)}`);
    if (sess.status === 402) logFundingHelp(sess.data);
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
        log(`not enough GOLD to cover the ${amount} stake — stopping`);
        logFundingHelp(r.data);
        break;
      }
    }
    await sleep(1000);
  }
  await client.leaveBlackjackTable(tableId).catch(() => {});
  log(`done: ${played} hands`);
}

// ---- poker seating ----

/*
 * A 409 from joinPokerTable is the documented WAY IN, not a wall. The tables
 * endpoint publishes the contract itself in `seating_note`:
 *
 *   "a join that returns 409 'seat taken' records your interest, and a seat is
 *    freed for you at the next hand boundary — usually within a few seconds —
 *    reserved for you ~45s. So a full table can still be joined, but only by
 *    attempting the join; there is no waitlist."
 *
 * Playce keeps the poker tables occupied by resident agents, so a full table is
 * the NORMAL case and the 409 is the mechanic. The kit used to get both halves
 * wrong: it skipped full tables (`if (t.seated >= t.seats) continue`) and gave
 * up after ~11s. A cold-run tester needed an external 40-line loop that simply
 * kept asking across every table and seat; it got in on attempt 36, ~2 minutes.
 * So: attempt full tables, rotate over every (table, seat) pair, re-read the
 * table list as seats free, and budget past the reservation window.
 */

/** Total claim budget. Must comfortably outlive the server's ~45s reservation
 *  hold — a seat freed for us at the next hand boundary is held ~45s for
 *  whoever asked, so quitting inside that window throws away the seat we
 *  already earned. 90s ≈ two full reservation windows. */
export const SEAT_CLAIM_BUDGET_MS = 90_000;
/** Pause between join attempts — the server's own suggested retry cadence. */
const SEAT_CLAIM_PAUSE_MS = 2_000;
/** How often to re-read the table list: occupancy changes at every hand boundary. */
const SEAT_CLAIM_REFETCH_MS = 12_000;

export interface SeatCandidate {
  tableId: string;
  seat: number;
  buyIn: number;
}

/**
 * Every (table, seat) pair worth asking for — free seats first, then OCCUPIED
 * seats, which are INCLUDED rather than skipped because the 409 they answer
 * with is exactly what puts us in line for the next hand boundary.
 *
 * `wantSeat >= 0` (POKER_SEAT) narrows to that one seat per table; `buyInEnv`
 * (POKER_BUYIN) is clamped into each table's own min/max buy-in.
 */
export function seatCandidates(
  tables: PokerTable[],
  opts: { wantSeat?: number; buyInEnv?: string } = {},
): SeatCandidate[] {
  const wantSeat = opts.wantSeat ?? -1;
  const free: SeatCandidate[] = [];
  const occupied: SeatCandidate[] = [];
  for (const t of tables) {
    const asked = Number(opts.buyInEnv);
    const buyIn = Math.max(t.min_buyin, Math.min(t.max_buyin, Number.isFinite(asked) ? asked : t.min_buyin));
    const taken = new Set((t.occupants ?? []).map((o) => o.seat));
    const seats =
      wantSeat >= 0 ? [wantSeat] : Array.from({ length: Math.max(0, t.seats) }, (_, s) => s);
    for (const seat of seats) {
      (taken.has(seat) ? occupied : free).push({ tableId: t.table_id, seat, buyIn });
    }
  }
  return [...free, ...occupied];
}

/**
 * What to do about a join response.
 *
 * - `seated`         — we're in (200, or a 409 saying we're already at this table).
 * - `keep-trying`    — the 409 that RECORDS OUR INTEREST (seat taken / a hand is
 *                      in progress / the room is reconciling), plus 429 and 5xx.
 * - `table-hopeless` — this table will never take us however long we wait:
 *                      common-owner (same creator already seated) and
 *                      anti-ratholing are permanent for this table/tier, and a
 *                      400 means our seat index or buy-in doesn't fit it. Retire
 *                      the table instead of burning budget on it.
 * - `stop`           — account-level: 402 (can't cover the buy-in — surface the
 *                      server's funding guidance) or 403 (no registered creator).
 *                      No table can fix these, so stop immediately.
 */
/** POKER_SEAT → a seat index, or -1 for "any seat". Blank/garbage means any. */
export function seatFromEnv(raw: string | undefined): number {
  const s = (raw ?? "").trim();
  if (!s) return -1;
  const n = Number(s);
  return Number.isInteger(n) && n >= 0 ? n : -1;
}

export type SeatVerdict = "seated" | "keep-trying" | "table-hopeless" | "stop";

export function classifySeatClaim(res: ApiResult): { verdict: SeatVerdict; message: string } {
  const message = serverMessage(res.data);
  if (res.status === 200) return { verdict: "seated", message };
  if (res.status === 402 || res.status === 403) return { verdict: "stop", message };
  if (res.status === 429 || res.status >= 500) return { verdict: "keep-trying", message };
  if (res.status === 409) {
    // Order matters: the common-owner message ("an agent with the same creator
    // is already seated at this table") CONTAINS "already seated", so the
    // permanent 409s have to be ruled out before the we're-already-in check —
    // otherwise the kit walks off to play a table it never got a seat at.
    if (/same creator|rejoining this tier|ratholing/i.test(message)) {
      return { verdict: "table-hopeless", message };
    }
    if (/agent already seated/i.test(message)) return { verdict: "seated", message };
    return { verdict: "keep-trying", message };
  }
  return { verdict: "table-hopeless", message };
}

/**
 * Keep asking until we have a seat or the budget runs out. Returns the table id,
 * or "" (having logged WHY, plus the server's last message) on failure.
 */
async function claimPokerSeat(
  client: PlayceClient,
  me: string,
  opts: { wantTable: string; wantSeat: number; clientSeed?: string; buyInEnv?: string },
): Promise<string> {
  const startedAt = Date.now();
  const until = startedAt + SEAT_CLAIM_BUDGET_MS;
  const elapsed = () => Math.round((Date.now() - startedAt) / 1000);
  const left = () => Math.max(0, Math.round((until - Date.now()) / 1000));
  /** table_id → why it can never seat us (dropped from the rotation). */
  const hopeless = new Map<string, string>();
  const tried = new Set<string>();
  let candidates: SeatCandidate[] = [];
  let fetchedAt = 0;
  let cursor = 0;
  let attempts = 0;
  let lastMessage = "";
  let stopReason = "";

  const refusedAll = () =>
    `every table refused us — ${[...hopeless].map(([t, m]) => `${t}: ${m}`).join(" | ")}`;

  while (Date.now() < until) {
    // Re-read the table list: seats free at hand boundaries, and the seat freed
    // for us is reserved for whoever asked — so keep asking off a fresh picture
    // instead of one stale snapshot taken before we started.
    if (candidates.length === 0 || Date.now() - fetchedAt >= SEAT_CLAIM_REFETCH_MS) {
      const { tables = [], paused } = (await client.pokerTables()).data ?? {};
      fetchedAt = Date.now();
      if (paused) {
        log("poker is paused — try again later");
        return "";
      }
      const usable = tables.filter(
        (t) => (!opts.wantTable || t.table_id === opts.wantTable) && !hopeless.has(t.table_id),
      );
      const seatedAt = usable.find((t) => (t.occupants ?? []).some((o) => o.agent === me));
      if (seatedAt) {
        log(`already seated at ${seatedAt.table_id} — playing on`);
        return seatedAt.table_id;
      }
      if (usable.length === 0) {
        stopReason = hopeless.size
          ? refusedAll()
          : opts.wantTable
            ? `POKER_TABLE_ID=${opts.wantTable} is not in the room's table list`
            : "the poker room is listing no tables right now";
        break;
      }
      candidates = seatCandidates(usable, { wantSeat: opts.wantSeat, buyInEnv: opts.buyInEnv });
      cursor = 0;
    }

    const c = candidates[cursor++ % candidates.length];
    attempts++;
    tried.add(c.tableId);
    const res = await client.joinPokerTable(c.tableId, c.seat, c.buyIn, opts.clientSeed);
    const { verdict, message } = classifySeatClaim(res);
    if (message) lastMessage = message;

    if (verdict === "seated") {
      log(`bought in: ${c.buyIn} GOLD at ${c.tableId} seat ${c.seat} (escrowed as your stack)`);
      return c.tableId;
    }

    if (verdict === "stop") {
      if (res.status === 402) {
        log(`not enough GOLD for the ${c.buyIn} buy-in at ${c.tableId}: ${message}`);
        logFundingHelp(res.data);
      } else {
        log(`join refused (HTTP ${res.status}): ${message}`);
        log("poker seats require an agent profile with a registered creator — see README.");
      }
      return "";
    }

    if (verdict === "table-hopeless") {
      hopeless.set(c.tableId, message);
      candidates = candidates.filter((x) => x.tableId !== c.tableId);
      log(`${c.tableId} can't seat us (HTTP ${res.status}: ${message}) — dropped from the rotation`);
      if (candidates.length === 0) {
        stopReason = refusedAll();
        break;
      }
      continue; // don't spend a 2s pause on a table we just retired
    }

    // keep-trying: this is the 409 that records our interest. Say so out loud —
    // a silent 90s loop looks hung.
    log(
      `claiming a seat… attempt ${attempts}, ${tried.size} table(s) tried, ${elapsed()}s in / ${left()}s left ` +
        `— ${c.tableId} seat ${c.seat}: HTTP ${res.status} ${message}`,
    );
    await sleep(SEAT_CLAIM_PAUSE_MS);
  }

  log(
    `no poker seat after ${attempts} attempt(s) over ${elapsed()}s across ${tried.size} table(s): ` +
      (stopReason || `every seat stayed occupied for the whole ${Math.round(SEAT_CLAIM_BUDGET_MS / 1000)}s budget`),
  );
  if (lastMessage) log(`server's last word: ${lastMessage}`);
  if (!stopReason) {
    log(
      "Seats free at hand boundaries and are held ~45s for whoever asked, so re-running `pnpm poker` " +
        "shortly is the normal way in. Set POKER_TABLE_ID / POKER_SEAT to aim at one spot.",
    );
  }
  return "";
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
    log(`hall session failed: HTTP ${sess.status} ${serverMessage(sess.data)}`);
    if (sess.status === 402) logFundingHelp(sess.data);
    return;
  }

  // Claim a seat; buy in (GOLD is debited NOW and escrowed as stack). Full
  // tables are attempted on purpose — see the SEAT_CLAIM_* block above.
  const tableId = await claimPokerSeat(client, me, {
    wantTable: (process.env.POKER_TABLE_ID || "").trim(),
    // `POKER_SEAT=` (present but blank — how .env.example ships it) must mean
    // "any seat", not Number("") === 0, which would pin us to seat 0 and undo
    // the whole rotation.
    wantSeat: seatFromEnv(process.env.POKER_SEAT),
    clientSeed: process.env.POKER_CLIENT_SEED || undefined,
    buyInEnv: process.env.POKER_BUYIN,
  });
  if (!tableId) return; // claimPokerSeat already logged why

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
      log(`not enough GOLD to stake a match (have ${status.data.balances.gold}, need ${status.data.matchCost}).`);
      logFundingHelp(status.data);
      process.exit(1);
    }
    await playRps(client, agentName, Number(process.env.MATCHES ?? 5));
  }
}

// Only run the live game loop when this file is executed directly (`tsx
// src/index.ts`, `pnpm start`, etc.) — NOT when it's imported for its
// exports (loadSavedCreds/SavedCreds, reused by scripts/mcp-stdio-bridge.ts).
// Without this guard, importing anything from this module would trigger a
// live match run as a side effect.
// pathToFileURL, NOT `file://${argv[1]}` — on Windows argv[1] is a backslash
// path like C:\Users\... so the template produced "file://C:\Users\..." while
// import.meta.url is "file:///C:/Users/...". They never matched, so main()
// silently never ran: `pnpm start` printed nothing and exited 0, with no error
// to search for. The kit was dead on Windows (found by a cold-run test).
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((e) => {
    console.error("fatal:", e);
    process.exit(1);
  });
}
