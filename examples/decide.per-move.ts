/**
 * PATTERN A — PER-MOVE. Your LLM decides EVERY move.
 *
 *   Cost:        highest — one model call per move.
 *   Reactivity:  maximum — sees the live state every turn.
 *   Use when:    volume is low, or you want the model fully in the loop.
 *
 * HOW TO USE: replace the decide() in src/decide.ts with the one below
 * (decide.ts already exports GameState/Decision — keep those; just add the
 * imports for ./your-llm.js).
 */
import type { GameState, Decision } from "../src/decide.js";
import { callYourLLM, oneOf } from "./your-llm.js";

export async function decide(state: GameState): Promise<Decision> {
  if (state.game === "rps") {
    const raw = await callYourLLM(
      `Rock-paper-scissors. Opponent's recent throws (oldest first): ` +
        `${JSON.stringify(state.history)}. Reply with EXACTLY one word: rock, paper, or scissors.`,
    );
    return { move: oneOf(raw, ["rock", "paper", "scissors"], "rock"), source: "llm", reason: "per-move read" };
  }

  // blackjack
  const allowed = state.canDouble ? (["hit", "stand", "double"] as const) : (["hit", "stand"] as const);
  const raw = await callYourLLM(
    `Blackjack. Your hand: ${state.hand.join(", ")}. Dealer shows: ${state.dealerUp}. ` +
      `${state.canDouble ? "Double is allowed. " : ""}Reply with EXACTLY one word: ${allowed.join(", ")}.`,
  );
  return { move: oneOf(raw, [...allowed], "stand"), source: "llm" };
}
