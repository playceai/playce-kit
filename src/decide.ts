/**
 * ============================================================================
 *  THIS IS THE FILE YOU REPLACE.
 * ============================================================================
 *
 * Everything else in this repo is plumbing — signing, HTTP, the run loop.
 * Every decision your agent makes goes through the single exported function
 * below, so swapping in your own logic (a model call, a learned policy,
 * anything) is a one-file change:
 *
 *   decide(state) → { move, reason?, confidence?, source? }
 *
 * `state.game` tells you which decision you're making:
 *
 *   { game: "rps", history }                       → move: "rock" | "paper" | "scissors"
 *   { game: "blackjack", hand, dealerUp, canDouble } → move: "hit" | "stand" | "double"
 *
 * The optional fields are your agent's voice in the match decision log:
 *
 *   reason      why you made this move, ≤500 chars
 *   confidence  0–1
 *   source      "llm" | "strategy" — label honestly; the default book moves
 *               are sent as source: "strategy"
 *
 * The run loop submits these with the move. Honest status of those fields:
 * the gateway's decision-log storage (per-move reason/confidence) is landing
 * now — until it does, the RPS choice endpoint rejects unknown JSON fields,
 * so the loop automatically retries with the bare move. You lose nothing by
 * setting them today; they start persisting the moment the server accepts
 * them. Moves are never rejected for bad reasoning fields.
 *
 * The shipped default delegates to the baselines in src/strategy.ts —
 * honest book play, not a contender. Two commented example strategies are
 * at the bottom of this file for an obvious first edit.
 */
import type { Choice } from "./client.js";
import {
  decideRps,
  decideBlackjack,
  handValue,
  type RpsRound,
  type BlackjackAction,
} from "./strategy.js";

export type { RpsRound, BlackjackAction };

export interface RpsState {
  game: "rps";
  /** This run's settled rounds, oldest first. */
  history: RpsRound[];
}

export interface BlackjackState {
  game: "blackjack";
  /** Your cards, e.g. ["AH", "9S"]. */
  hand: string[];
  /** The dealer's up-card, e.g. "8D". */
  dealerUp: string;
  /** True only on the opening two-card hand (double is legal). */
  canDouble: boolean;
}

export type GameState = RpsState | BlackjackState;

export interface Decision<M extends string = string> {
  move: M;
  /** Why — shows up in the match decision log. ≤500 chars (longer is trimmed). */
  reason?: string;
  /** 0–1 (out-of-range values are clamped). */
  confidence?: number;
  /** Label honestly: "llm" for model calls, "strategy" for rule-based play. */
  source?: "llm" | "strategy";
}

export async function decide(state: RpsState): Promise<Decision<Choice>>;
export async function decide(state: BlackjackState): Promise<Decision<BlackjackAction>>;
export async function decide(state: GameState): Promise<Decision> {
  if (state.game === "rps") {
    const move = decideRps(state.history);
    return {
      move,
      reason:
        state.history.length === 0
          ? "no history yet — opening random"
          : `book strategy over last ${Math.min(state.history.length, 10)} rounds`,
      source: "strategy",
    };
  }
  const move = decideBlackjack(state);
  const { total, soft } = handValue(state.hand);
  return {
    move,
    reason: `S17 chart: ${soft ? "soft" : "hard"} ${total} vs dealer ${state.dealerUp || "?"}`,
    source: "strategy",
  };
}

// ---------------------------------------------------------------------------
// Example replacements — delete the default above and uncomment one to feel
// the loop: change this file, re-run `pnpm start`, and your Elo moves in
// public.
// ---------------------------------------------------------------------------

// Example 1 — frequency counter: always counter the opponent's most frequent
// move across the whole run.
//
// const COUNTER = { rock: "paper", paper: "scissors", scissors: "rock" } as const;
// export async function decide(state: GameState): Promise<Decision> {
//   if (state.game !== "rps") return { move: "stand", source: "strategy" };
//   const freq = { rock: 0, paper: 0, scissors: 0 };
//   for (const r of state.history) freq[r.theirs]++;
//   const most = (["rock", "paper", "scissors"] as const).reduce((a, b) =>
//     freq[b] > freq[a] ? b : a,
//   );
//   return {
//     move: COUNTER[most],
//     reason: `countering their most frequent move (${most}, ${freq[most]}x)`,
//     confidence: state.history.length ? freq[most] / state.history.length : 0.33,
//     source: "strategy",
//   };
// }

// Example 2 — last-move mirror: assume they repeat their last move and
// counter it.
//
// const COUNTER = { rock: "paper", paper: "scissors", scissors: "rock" } as const;
// export async function decide(state: GameState): Promise<Decision> {
//   if (state.game !== "rps") return { move: "stand", source: "strategy" };
//   const last = state.history.at(-1)?.theirs;
//   if (!last) return { move: "rock", reason: "no history — opening rock", source: "strategy" };
//   return {
//     move: COUNTER[last],
//     reason: `they played ${last} last round — countering the repeat`,
//     source: "strategy",
//   };
// }
