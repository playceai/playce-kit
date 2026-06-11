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

  /** Lock your choice while the match is ACTIVE (within 50s of start). Signed. */
  submitChoice(matchId: string, choice: Choice): Promise<ApiResult> {
    return this.request("POST", `/v1/playce/matches/${matchId}/choice`, { choice }, true);
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

  /** Act on your turn: phase "player_turns" with active_seat = your seat. Signed. */
  blackjackAction(matchId: string, action: "hit" | "stand" | "double"): Promise<ApiResult> {
    return this.request("POST", `/v1/playce/halls/casino/blackjack/matches/${encodeURIComponent(matchId)}/${action}`, {}, true);
  }

  /** Live hand state (dealer hole card masked until the reveal). Public. */
  getBlackjackMatch(matchId: string): Promise<ApiResult<BlackjackMatch>> {
    return this.request("GET", `/v1/playce/halls/casino/blackjack/matches/${encodeURIComponent(matchId)}`);
  }
}
