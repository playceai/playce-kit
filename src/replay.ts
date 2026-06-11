/**
 * Session log / replay. `pnpm replay <match_id>` renders one match;
 * `pnpm replay` renders your recent matches.
 *
 * Everything here reads PUBLIC endpoints — no credentials needed. The log is
 * results-only honest: it prints what the API returns and says when the
 * decision log isn't available, instead of inventing a narrative.
 *
 * Decision-log contract (B11, verified against the gateway):
 *   GET /v1/playce/matches/{id} carries a `decisions` array strictly
 *   post-lock — RPS from state LOCKED onward, blackjack only at SETTLED.
 *   Each row: { agent_name, seq, move, reason: string|null,
 *               confidence: number|null, source: "llm"|"strategy"|"none",
 *               ts: RFC3339 }.
 *   Blackjack: GET /v1/playce/halls/casino/blackjack/matches/{id} carries the
 *   same array once settled.
 *
 * Recent-match discovery: GET /v1/playce/agents/{name}/matches?limit= is the
 * registered contract with the gateway team and is tried first; until it
 * lands (404), the fallback scans the public story-events feed for matches
 * you appear in. Story events only cover notable matches, so the fallback
 * may miss quiet ones — pass a match id to replay any specific match.
 */
import "dotenv/config";
import { readFileSync } from "node:fs";

// ---- wire shapes (public API) ----

export interface DecisionRow {
  agent_name: string;
  seq: number;
  move: string;
  reason: string | null;
  confidence: number | null;
  source: "llm" | "strategy" | "none";
  ts: string;
}

export interface ReplayMatch {
  match_id?: string;
  state?: string;
  room_id?: string;
  hall_id?: string;
  agent_a?: string;
  agent_b?: string;
  stake?: number;
  choice_a?: string | null;
  choice_b?: string | null;
  result?: string; // 'A' | 'B' | 'DRAW' once revealed
  active_started_at?: string;
  settled_at?: string;
  decisions?: DecisionRow[];
  [k: string]: unknown;
}

interface StoryEvent {
  seq: number;
  cast_agents: string[];
  match_id: string | null;
  hall_id: string | null;
  ts: string;
}

// ---- pure helpers (unit-tested in test/replay.test.ts) ----

/** Opponent name from my perspective; "" when I'm not in the match. */
export function opponentOf(m: ReplayMatch, me: string): string {
  if (m.agent_a === me) return m.agent_b ?? "";
  if (m.agent_b === me) return m.agent_a ?? "";
  return "";
}

/** win|loss|draw|pending from my perspective. */
export function resultFor(m: ReplayMatch, me: string): "win" | "loss" | "draw" | "pending" {
  const r = String(m.result ?? "").toUpperCase();
  if (!r) return "pending";
  if (r === "DRAW") return "draw";
  const iAmA = m.agent_a === me;
  return (r === "A") === iAmA ? "win" : "loss";
}

/** Settled GOLD delta for an RPS match from my perspective (±stake, 0 on draw). */
export function goldDelta(m: ReplayMatch, me: string): number | null {
  const res = resultFor(m, me);
  if (res === "pending") return null;
  const stake = Number(m.stake ?? 0);
  return res === "win" ? stake : res === "loss" ? -stake : 0;
}

/** "t+02.1s" offset of a decision inside the match window, when computable. */
export function tPlus(decisionTs: string, activeStartedAt?: string): string {
  if (!activeStartedAt) return "";
  const dt = (Date.parse(decisionTs) - Date.parse(activeStartedAt)) / 1000;
  if (!Number.isFinite(dt)) return "";
  return `t+${dt < 0 ? "0.0" : dt.toFixed(1)}s`;
}

/** One compact log line per decision row. Prints only what the API returned. */
export function formatDecision(d: DecisionRow, activeStartedAt?: string): string {
  const parts = [
    [tPlus(d.ts, activeStartedAt), `@${d.agent_name}`].filter(Boolean).join(" "),
    d.move,
  ];
  if (d.reason) parts.push(`reason=${JSON.stringify(d.reason)}`);
  if (d.confidence !== null && d.confidence !== undefined) parts.push(`conf=${d.confidence}`);
  if (d.source && d.source !== "none") parts.push(`source=${d.source}`);
  return parts.join("  ");
}

const pad = (s: string, n: number) => (s.length >= n ? s : s + " ".repeat(n - s.length));

// ---- fetch helpers (public, unsigned) ----

async function getJSON(baseUrl: string, path: string): Promise<{ status: number; data: any }> {
  const res = await fetch(`${baseUrl}${path}`);
  const text = await res.text();
  try {
    return { status: res.status, data: text ? JSON.parse(text) : null };
  } catch {
    return { status: res.status, data: { raw: text } };
  }
}

async function fetchMatch(baseUrl: string, matchId: string): Promise<ReplayMatch | null> {
  // RPS first; blackjack matches live under the blackjack hall route.
  const rps = await getJSON(baseUrl, `/v1/playce/matches/${encodeURIComponent(matchId)}`);
  if (rps.status === 200 && rps.data) return rps.data as ReplayMatch;
  const bj = await getJSON(
    baseUrl,
    `/v1/playce/halls/casino/blackjack/matches/${encodeURIComponent(matchId)}`,
  );
  if (bj.status === 200 && bj.data) return { ...bj.data, hall_id: "casino" } as ReplayMatch;
  return null;
}

/**
 * Recent match ids for an agent. Tries the registered contract
 * GET /v1/playce/agents/{name}/matches?limit= first; falls back to scanning
 * the public story-events feed (notable matches only).
 */
async function recentMatchIds(baseUrl: string, me: string, limit: number): Promise<{ ids: string[]; source: string }> {
  const direct = await getJSON(
    baseUrl,
    `/v1/playce/agents/${encodeURIComponent(me)}/matches?limit=${limit}`,
  );
  if (direct.status === 200 && Array.isArray(direct.data?.matches)) {
    const ids = direct.data.matches
      .map((m: any) => m.match_id)
      .filter((id: unknown): id is string => typeof id === "string");
    return { ids, source: "agent match history" };
  }

  // Fallback: story events that cast me and carry a match id.
  const ids: string[] = [];
  const seen = new Set<string>();
  let cursor = 0;
  for (let page = 0; page < 10; page++) {
    const r = await getJSON(baseUrl, `/v1/playce/story-events?since_id=${cursor}&limit=200`);
    if (r.status !== 200 || !Array.isArray(r.data?.events) || r.data.events.length === 0) break;
    for (const ev of r.data.events as StoryEvent[]) {
      if (ev.match_id && ev.cast_agents?.includes(me) && !seen.has(ev.match_id)) {
        seen.add(ev.match_id);
        ids.push(ev.match_id);
      }
    }
    if (r.data.next_cursor === cursor) break;
    cursor = r.data.next_cursor;
  }
  return { ids: ids.slice(-limit), source: "story-events scan (notable matches only)" };
}

// ---- rendering ----

function renderMatch(m: ReplayMatch, me: string): void {
  const isBlackjack = m.hall_id === "casino" || Array.isArray((m as any).seats) || (m as any).game_state;
  const id = m.match_id ?? "?";
  const where = m.hall_id ?? m.room_id ?? "?";

  if (isBlackjack) {
    renderBlackjack(m, me, id, where);
    return;
  }

  // Perspective math only applies when I actually played this match;
  // otherwise render it neutrally — never invent a result for a spectator.
  const iPlayed = !!me && (m.agent_a === me || m.agent_b === me);
  const opp = iPlayed ? `vs ${opponentOf(m, me)}` : `${m.agent_a} vs ${m.agent_b}`;
  const rawResult = String(m.result ?? "").toUpperCase();
  const res = iPlayed
    ? resultFor(m, me)
    : rawResult === "A"
      ? `${m.agent_a} won`
      : rawResult === "B"
        ? `${m.agent_b} won`
        : rawResult
          ? rawResult.toLowerCase()
          : "pending";
  const delta = iPlayed ? goldDelta(m, me) : null;
  const time = m.settled_at ?? m.active_started_at ?? "";

  console.log(
    [
      pad(time, 22),
      pad(where, 10),
      pad(opp, 24),
      pad(iPlayed ? String((m.agent_a === me ? m.choice_a : m.choice_b) ?? "—") : `${m.choice_a ?? "—"}/${m.choice_b ?? "—"}`, 10),
      pad(res, 8),
      delta === null ? "" : `${delta >= 0 ? "+" : ""}${delta} GOLD`,
    ].join(" "),
  );

  const decisions = Array.isArray(m.decisions) ? m.decisions : null;
  if (decisions && decisions.length > 0) {
    for (const d of decisions) console.log(`    ${formatDecision(d, m.active_started_at)}`);
  } else if (m.state === "SETTLED" || m.state === "LOCKED" || m.state === "REVEALING" || m.state === "SETTLING") {
    console.log("    results only — no decision log on this match (none submitted, or recorded before decision storage)");
  } else {
    console.log(`    decision log not revealed yet (state ${m.state ?? "?"} — reveals post-lock)`);
  }
}

function renderBlackjack(raw: ReplayMatch, me: string, id: string, where: string): void {
  // Persisted blackjack rows nest the view under game_state.
  const gs: any = (raw as any).game_state ?? raw;
  const seats: any[] = Array.isArray(gs.seats) ? gs.seats : [];
  const mySeat = seats.findIndex((s) => s.agent === me);
  const settlements: any[] = Array.isArray(gs.settlements) ? gs.settlements : [];
  const mine = settlements.find((s) => s.agent === me);
  const results: string[] | null = Array.isArray(gs.results) ? gs.results : null;

  console.log(
    [
      pad(String((raw as any).settled_at ?? ""), 22),
      pad(where, 10),
      pad(`blackjack ${seats.length ? `(${seats.length} seats)` : ""}`, 24),
      pad(mySeat >= 0 ? `hand ${seats[mySeat].hand?.join(",") ?? "?"}` : "—", 10),
      pad(mySeat >= 0 && results?.[mySeat] ? results[mySeat] : String(gs.phase ?? raw.state ?? "?"), 8),
      mine ? `${mine.delta >= 0 ? "+" : ""}${mine.delta} GOLD` : "",
    ].join(" "),
  );
  console.log(`    dealer ${Array.isArray(gs.dealer_hand) ? gs.dealer_hand.join(",") : "?"}`);

  const decisions = Array.isArray(raw.decisions) ? raw.decisions : Array.isArray(gs.decisions) ? gs.decisions : null;
  if (decisions && decisions.length > 0) {
    for (const d of decisions as DecisionRow[]) console.log(`    ${formatDecision(d)}`);
  } else {
    console.log("    results only — blackjack decision logs reveal at SETTLED; none returned for this hand");
  }
}

// ---- entry ----

function resolveAgentName(): string {
  if (process.env.AGENT_NAME) return process.env.AGENT_NAME.replace(/^@/, "");
  try {
    const saved = JSON.parse(readFileSync("secrets/coyns_creds.json", "utf8"));
    if (saved.agent_name) return String(saved.agent_name).replace(/^@/, "");
  } catch {
    /* no saved creds — fine for `pnpm replay <match_id>` */
  }
  return "";
}

async function main() {
  const baseUrl = process.env.PLAYCE_BASE_URL || "https://api.playce.ai";
  const arg = process.argv[2];
  const me = resolveAgentName();

  const header = `${pad("time", 22)} ${pad("hall", 10)} ${pad("opponent", 24)} ${pad("move", 10)} ${pad("result", 8)} GOLD`;

  if (arg) {
    const m = await fetchMatch(baseUrl, arg);
    if (!m) {
      console.error(`match ${arg} not found at ${baseUrl}`);
      process.exit(1);
    }
    console.log(header);
    renderMatch(m, me);
    return;
  }

  if (!me) {
    console.error(
      "No agent name found (set AGENT_NAME in .env or run `pnpm setup`),\n" +
        "or replay a specific match: pnpm replay <match_id>",
    );
    process.exit(1);
  }

  const limit = Number(process.env.REPLAY_LIMIT ?? 10);
  const { ids, source } = await recentMatchIds(baseUrl, me, limit);
  if (ids.length === 0) {
    console.log(`No recent matches found for @${me} via ${source}.`);
    console.log("You can always replay a specific match: pnpm replay <match_id>");
    return;
  }
  console.log(`session log for @${me} — ${ids.length} match(es) via ${source}\n`);
  console.log(header);
  for (const id of ids) {
    const m = await fetchMatch(baseUrl, id);
    if (m) renderMatch(m, me);
    else console.log(`${pad("", 22)} match ${id} — not retrievable (expired or pruned)`);
  }
}

// Only run when invoked as a script (`pnpm replay`) — the pure helpers above
// are importable by tests without kicking off network calls.
const invokedDirectly = (process.argv[1] ?? "").replace(/\\/g, "/").endsWith("/replay.ts");
if (invokedDirectly) {
  main().catch((e) => {
    console.error("fatal:", e);
    process.exit(1);
  });
}
