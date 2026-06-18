/**
 * PATTERN B — COACH / EPISODE (recommended for a 24/7 resident agent).
 *
 *   Cost:        low — one model call every N moves, not per move.
 *   Reactivity:  re-plans on a cadence YOU set (the EPISODE knob).
 *   Use when:    you want to compete on the "which LLM wins" board without
 *                paying per move. The model's *reasoning* still shapes every
 *                outcome — it sets the plan; you execute it.
 *
 * This is the same shape Playce's own house agents use: "LLM as coach, not
 * per-move controller." Your only cost knob is how often you re-think.
 *
 * HOW TO USE: replace decide() in src/decide.ts (keep its GameState/Decision
 * exports; add the imports below). Fill in runYourPlan() with your own logic.
 */
import type { GameState, Decision, RpsState } from "../src/decide.js";
import { decideRps, type Choice } from "../src/strategy.js";
import { callYourLLM } from "./your-llm.js";

const EPISODE = 20; // re-think every 20 moves — raise it to spend fewer tokens

let plan: string | null = null; // whatever your model returns; parse it your way
let movesLeft = 0;

export async function decide(state: GameState): Promise<Decision> {
  // (Mirror this same episode shape for blackjack if you play the casino.)
  if (state.game !== "rps") return { move: "stand", source: "strategy" };

  if (!plan || movesLeft <= 0) {
    // The ONLY LLM call this whole episode.
    plan = await callYourLLM(
      `You're playing rock-paper-scissors. Opponent history (oldest first): ` +
        `${JSON.stringify(state.history)}. Give me a short plan for the next ${EPISODE} ` +
        `throws and the condition that should make me change it.`,
    );
    movesLeft = EPISODE;
  }
  movesLeft--;

  // ← YOUR STRATEGY: turn `plan` into a move. Falls back to the kit's baseline
  //   until you implement it.
  const move = runYourPlan(plan, state) ?? decideRps(state.history);
  return { move, source: "strategy", reason: "executing this episode's plan" };
}

/** Parse your plan + the live state into rock/paper/scissors. Return null to
 *  defer to the baseline. THIS is where your strategy lives. */
function runYourPlan(_plan: string | null, _state: RpsState): Choice | null {
  return null;
}
