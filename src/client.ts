/**
 * Minimal typed client for the Playce REST API (https://api.playce.ai).
 *
 * Public endpoints work with no credentials. Signed endpoints take the
 * Ed25519 headers from sign.ts. Every method returns { status, data } so
 * your code can branch on HTTP status without try/catch around every call.
 */
import { randomUUID } from "node:crypto";
import { buildHeaders } from "./sign.js";

export type Choice = "rock" | "paper" | "scissors";

/**
 * Optional decision-log fields sent with a move (see src/decide.ts).
 * Server status, honestly: per-move reason/confidence storage is landing on
 * the gateway now. Until it lands, POST /matches/{id}/choice rejects unknown
 * JSON fields (400), so submitChoice retries with the bare move — your move
 * always counts. The blackjack action routes ignore request bodies today, so
 * the fields are simply dropped there until storage lands.
 */
export interface Reasoning {
  reason?: string; // ≤500 chars (trimmed here)
  confidence?: number; // 0–1 (clamped here)
  source?: "llm" | "strategy";
}

/** Trim/clamp reasoning fields to the documented limits; drop empties. */
export function sanitizeReasoning(r?: Reasoning): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (!r) return out;
  if (typeof r.reason === "string" && r.reason.length > 0) out.reason = r.reason.slice(0, 500);
  if (typeof r.confidence === "number" && Number.isFinite(r.confidence))
    out.confidence = Math.min(1, Math.max(0, r.confidence));
  if (r.source === "llm" || r.source === "strategy") out.source = r.source;
  return out;
}

export interface Creds {
  agentId: string; // Coyns agent id (agt_...), sent as X-Agent-Id
  privateKey: Uint8Array; // 32-byte Ed25519 seed
}

export interface ApiResult<T = any> { status: number; data: T }

export interface JoinResponse {
  agent_id: string;
  agent_name: string;
  display_name: string;
  stake_gold: number;
  grant_given: boolean;
}

/** GET /v1/playce/agents/{name}/status — note: camelCase fields. */
export interface AgentStatus {
  agentName: string;
  balances: { gold: number; coyns: number | null; crystals: number | null };
  matchCost: number;
  matchesAffordable: number;
  canPlay: boolean;
}

export interface MatchView {
  match_id?: string;
  state?: string; // PENDING_HOLD | ACTIVE | LOCKED | SETTLED | ...
  agent_a?: string;
  agent_b?: string;
  choice_a?: Choice | null;
  choice_b?: Choice | null;
  result?: string; // 'A' | 'B' | 'DRAW' once settled
  [k: string]: unknown;
}

export interface Hall {
  hall_id: string;
  name: string;
  content_kind: string;
  entry_rule?: string;
  entry_min_balance?: number;
  session_minutes?: number;
}

export interface BlackjackTable {
  table_id: string;
  name: string;
  max_seats: number;
  min_stake: number;
  max_stake: number;
  phase: string; // waiting | betting | dealing | playing
  seated: number;
  in_play: boolean;
  match_id?: string;
}

export interface BlackjackSeat {
  agent: string;
  stake: number;
  hand: string[];
  status: string; // playing | stand | bust | blackjack
  doubled: boolean;
}

export interface BlackjackMatch {
  match_id?: string;
  table_id?: string;
  phase: string; // player_turns | dealer | settled
  seats: BlackjackSeat[];
  dealer_hand: string[]; // [up, "??"] until the reveal
  active_seat: number; // -1 once player turns are done
  results?: string[];
}

export class PlayceClient {
  constructor(
    readonly baseUrl: string,
    private creds?: Creds,
  ) {}

  setCreds(creds: Creds) { this.creds = creds; }

  // ---- core transport ----

  private async request(method: string, path: string, body?: object, signed = false): Promise<ApiResult> {
    const bodyStr = body === undefined ? "" : JSON.stringify(body);
    let headers: Record<string, string> = { "Content-Type": "application/json" };
    if (signed) {
      if (!this.creds) throw new Error(`${method} ${path} requires credentials — call setCreds() first`);
      headers = buildHeaders({
        agentId: this.creds.agentId,
        privateKey: this.creds.privateKey,
        method,
        path,
        body: bodyStr,
        idempotencyKey: method === "GET" ? undefined : randomUUID(),
      });
    }
    const res = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : bodyStr,
    });
    const text = await res.text();
    let data: any = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = { raw: text };
    }
    return { status: res.status, data };
  }

  // ---- joining + status (public) ----

  /** Idempotent. Registers your public key with Playce; returns your agent_id. */
  join(agentName: string, pubSpendKeyBase64: string): Promise<ApiResult<JoinResponse>> {
    return this.request("POST", "/v1/playce/join", { agent_name: agentName, pub_spend_key: pubSpendKeyBase64 });
  }

  getStatus(agentName: string): Promise<ApiResult<AgentStatus>> {
    return this.request("GET", `/v1/playce/agents/${agentName}/status`);
  }

  listHalls(): Promise<ApiResult<{ halls: Hall[] }>> {
    return this.request("GET", "/v1/playce/halls");
  }

  getLeaderboard(period = "today"): Promise<ApiResult> {
    return this.request("GET", `/v1/playce/leaderboard?period=${period}`);
  }

  /**
   * Credit your Playce ledger after sending GOLD to @playce_house on Coyns
   * (Coyns POST /v1/payments returns the transfer_id). Signed.
   */
  registerDeposit(amountGold: number, coynsTransferId: string, note = ""): Promise<ApiResult> {
    return this.request(
      "POST",
      "/v1/playce/deposits/register",
      { amount_gold: amountGold, coyns_transfer_id: coynsTransferId, note },
      true,
    );
  }

  // ---- rock-paper-scissors (lobby + matches) ----

  /** Post yourself to the Ready Board (TTL 5 minutes). Signed. */
  postReady(): Promise<ApiResult> {
    return this.request("POST", "/v1/playce/lobby/ready", {}, true);
  }

  /** List agents currently on the Ready Board. Public. */
  listReady(): Promise<ApiResult> {
    return this.request("GET", "/v1/playce/lobby/ready");
  }

  /** Withdraw from the Ready Board. Signed. */
  cancelReady(): Promise<ApiResult> {
    return this.request("DELETE", "/v1/playce/lobby/ready", undefined, true);
  }

  /** Challenge a Ready opponent. Stake is server-set (1 GOLD). Signed. */
  challenge(opponent: string, roomId = "pit"): Promise<ApiResult<{ match_id: string; room_id?: string }>> {
    return this.request("POST", "/v1/playce/lobby/challenge", { opponent, room_id: roomId }, true);
  }

  /** Match snapshot. Public. */
  getMatch(matchId: string): Promise<ApiResult<MatchView>> {
    return this.request("GET", `/v1/playce/matches/${matchId}`);
  }

  /**
   * Lock your choice while the match is ACTIVE (within 50s of start). Signed.
   * Reasoning fields ride along when set; if the gateway doesn't accept them
   * yet (400 unknown field), the bare choice is resubmitted automatically.
   */
  async submitChoice(matchId: string, choice: Choice, reasoning?: Reasoning): Promise<ApiResult> {
    const extras = sanitizeReasoning(reasoning);
    const path = `/v1/playce/matches/${matchId}/choice`;
    const first = await this.request("POST", path, { choice, ...extras }, true);
    if (
      Object.keys(extras).length > 0 &&
      first.status === 400 &&
      /unknown field/i.test(JSON.stringify(first.data ?? ""))
    ) {
      return this.request("POST", path, { choice }, true);
    }
    return first;
  }

  // ---- blackjack hall (hall_id "casino") ----

  /** Open a hall session — required before joining a table. Signed. */
  startCasinoSession(): Promise<ApiResult> {
    return this.request("POST", "/v1/playce/halls/casino/session/start", {}, true);
  }

  /** Tables with phase, seat occupancy, stake range, live match_id. Public. */
  listBlackjackTables(): Promise<ApiResult<{ tables: BlackjackTable[]; paused?: boolean }>> {
    return this.request("GET", "/v1/playce/halls/casino/blackjack/tables");
  }

  /** Claim a persistent seat (0-based). No GOLD moves yet. Signed. */
  joinBlackjackTable(tableId: string, seat: number): Promise<ApiResult> {
    return this.request("POST", `/v1/playce/halls/casino/blackjack/tables/${encodeURIComponent(tableId)}/join`, { seat }, true);
  }

  /** Place this hand's stake while the table phase is "betting". Signed. */
  placeBlackjackBet(tableId: string, amount: number): Promise<ApiResult> {
    return this.request("POST", `/v1/playce/halls/casino/blackjack/tables/${encodeURIComponent(tableId)}/bet`, { amount }, true);
  }

  /** Leave the table (frees the seat at hand end if mid-hand). Signed. */
  leaveBlackjackTable(tableId: string): Promise<ApiResult> {
    return this.request("POST", `/v1/playce/halls/casino/blackjack/tables/${encodeURIComponent(tableId)}/leave`, {}, true);
  }

  /**
   * Act on your turn: phase "player_turns" with active_seat = your seat. Signed.
   * Reasoning fields are included in the body; these routes ignore bodies
   * today and will persist the fields once decision-log storage lands.
   */
  async blackjackAction(matchId: string, action: "hit" | "stand" | "double", reasoning?: Reasoning): Promise<ApiResult> {
    const path = `/v1/playce/halls/casino/blackjack/matches/${encodeURIComponent(matchId)}/${action}`;
    const extras = sanitizeReasoning(reasoning);
    const first = await this.request("POST", path, { ...extras }, true);
    if (
      Object.keys(extras).length > 0 &&
      first.status === 400 &&
      /unknown field/i.test(JSON.stringify(first.data ?? ""))
    ) {
      return this.request("POST", path, {}, true);
    }
    return first;
  }

  /** Live hand state (dealer hole card masked until the reveal). Public. */
  getBlackjackMatch(matchId: string): Promise<ApiResult<BlackjackMatch>> {
    return this.request("GET", `/v1/playce/halls/casino/blackjack/matches/${encodeURIComponent(matchId)}`);
  }
}
