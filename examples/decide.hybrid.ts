/**
 * PATTERN C — HYBRID / TRIGGERED. Deterministic baseline for routine moves;
 * the LLM only fires on high-leverage moments.
 *
 *   Cost:        minimal — tokens spent only where they swing the result.
 *   Reactivity:  sharp exactly where it matters (close calls, streaks).
 *   Use when:    most moves are obvious (blackjack basic strategy is already
 *                near-optimal) and you want the model for the hard decisions.
 *
 * HOW TO USE: replace decide() in src/decide.ts (keep its GameState/Decision
 * exports; add the imports below). Edit the TRIGGERS to taste.
 */
import type { GameState, Decision, RpsState } from "../src/decide.js";
import { decideRps, decideBlackjack, handValue } from "../src/strategy.js";
import { callYourLLM, oneOf } from "./your-llm.js";

export async function decide(state: GameState): Promise<Decision> {
  if (state.game === "rps") {
    // Routine: play the baseline. TRIGGER the LLM only when it matters to you —
    // here, when you're cold and want a fresh read.
    if (onLosingStreak(state)) {
      const raw = await callYourLLM(
        `I keep losing rock-paper-scissors. Opponent: ${JSON.stringify(state.history)}. ` +
          `Reply with EXACTLY one word: rock, paper, or scissors.`,
      );
      return { move: oneOf(raw, ["rock", "paper", "scissors"], "rock"), source: "llm", reason: "breaking the streak" };
    }
    return { move: decideRps(state.history), source: "strategy" };
  }

  // Blackjack: the chart is near-optimal, so only ask the model on the coin-flips.
  const { total, soft } = handValue(state.hand);
  if (!soft && total >= 15 && total <= 16) {
    const raw = await callYourLLM(
      `Blackjack. Hand ${state.hand.join(", ")} vs dealer ${state.dealerUp}. ` +
        `Reply with EXACTLY one word: hit or stand.`,
    );
    return { move: oneOf(raw, ["hit", "stand"], "stand"), source: "llm", reason: "close call" };
  }
  return {
    move: decideBlackjack({ hand: state.hand, dealerUp: state.dealerUp, canDouble: state.canDouble }),
    source: "strategy",
  };
}

/** Your trigger — here, the last 3 results were all losses. */
function onLosingStreak(state: RpsState): boolean {
  const last3 = state.history.slice(-3);
  return last3.length === 3 && last3.every((r) => r.result === "loss");
}
