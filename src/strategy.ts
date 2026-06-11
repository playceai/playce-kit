/**
 * ============================================================================
 *  THIS IS THE FILE YOU REPLACE.
 * ============================================================================
 *
 * Everything else in this repo is plumbing — signing, HTTP, the run loop.
 * The two functions below are your agent's actual brain. Each game's decision
 * goes through exactly one exported function, so swapping in your own logic
 * (a model call, a learned policy, anything) is a one-file change.
 *
 *   decideRps(history)        → "rock" | "paper" | "scissors"
 *   decideBlackjack(context)  → "hit" | "stand" | "double"
 *
 * The shipped defaults are honest baselines, not contenders: weighted-random
 * RPS with streak awareness, and the textbook S17 blackjack chart.
 */
import type { Choice } from "./client.js";

// ---------------------------------------------------------------------------
// Rock-paper-scissors
// ---------------------------------------------------------------------------

export interface RpsRound {
  ours: Choice;
  theirs: Choice;
  result: "win" | "loss" | "draw";
}

const CHOICES: Choice[] = ["rock", "paper", "scissors"];
const COUNTER: Record<Choice, Choice> = { rock: "paper", paper: "scissors", scissors: "rock" };

const randomChoice = (): Choice => CHOICES[Math.floor(Math.random() * CHOICES.length)];

/**
 * Default RPS strategy. history is this run's settled rounds against whoever
 * we drew, oldest first. Replace this body with your own decision logic.
 */
export function decideRps(history: RpsRound[]): Choice {
  const recent = history.slice(-10);
  if (recent.length === 0) return randomChoice();

  // Streak awareness: if the opponent played the same move 2+ times in a row,
  // assume they'll repeat it and play the counter.
  const last = recent[recent.length - 1].theirs;
  let streak = 0;
  for (let i = recent.length - 1; i >= 0 && recent[i].theirs === last; i--) streak++;
  if (streak >= 2) return COUNTER[last];

  // Otherwise: 70% of the time counter their most frequent recent move,
  // 30% pure random so we stay hard to model ourselves.
  if (Math.random() < 0.7) {
    const freq: Record<Choice, number> = { rock: 0, paper: 0, scissors: 0 };
    for (const r of recent) freq[r.theirs]++;
    const most = CHOICES.reduce((a, b) => (freq[b] > freq[a] ? b : a));
    return COUNTER[most];
  }
  return randomChoice();
}

// ---------------------------------------------------------------------------
// Blackjack (single deck, dealer stands on 17, hit/stand/double only)
// ---------------------------------------------------------------------------

export type BlackjackAction = "hit" | "stand" | "double";

export interface BlackjackContext {
  /** Your cards, e.g. ["AH", "9S"]. */
  hand: string[];
  /** The dealer's up-card, e.g. "8D". */
  dealerUp: string;
  /** True only on the opening two-card hand (double is legal). */
  canDouble: boolean;
}

const rankOf = (card: string): string => (card.length >= 2 ? card.slice(0, -1) : card);

function cardValue(card: string): number {
  const r = rankOf(card);
  if (r === "A") return 11;
  if (r === "10" || r === "J" || r === "Q" || r === "K") return 10;
  return Number(r);
}

/** Best non-busting total of a hand, plus whether it is soft (Ace as 11). */
export function handValue(hand: string[]): { total: number; soft: boolean } {
  let total = 0;
  let aces = 0;
  for (const c of hand) {
    total += cardValue(c);
    if (rankOf(c) === "A") aces++;
  }
  let soft = aces;
  while (total > 21 && soft > 0) {
    total -= 10;
    soft--;
  }
  return { total, soft: soft > 0 };
}

/**
 * Default blackjack strategy: the textbook S17 chart. "double" degrades to
 * the fallback action when doubling isn't legal. Replace at will.
 */
export function decideBlackjack(ctx: BlackjackContext): BlackjackAction {
  const { total, soft } = handValue(ctx.hand);
  const up = cardValue(ctx.dealerUp);
  const dbl = (otherwise: BlackjackAction): BlackjackAction => (ctx.canDouble ? "double" : otherwise);

  if (soft) {
    if (total >= 19) return "stand";
    if (total === 18) {
      if (up >= 3 && up <= 6) return dbl("stand");
      if (up === 2 || up === 7 || up === 8) return "stand";
      return "hit";
    }
    if (total === 17) return up >= 3 && up <= 6 ? dbl("hit") : "hit";
    if (total >= 15) return up >= 4 && up <= 6 ? dbl("hit") : "hit";
    return up >= 5 && up <= 6 ? dbl("hit") : "hit";
  }

  if (total >= 17) return "stand";
  if (total >= 13) return up >= 2 && up <= 6 ? "stand" : "hit";
  if (total === 12) return up >= 4 && up <= 6 ? "stand" : "hit";
  if (total === 11) return dbl("hit");
  if (total === 10) return up >= 2 && up <= 9 ? dbl("hit") : "hit";
  if (total === 9) return up >= 3 && up <= 6 ? dbl("hit") : "hit";
  return "hit";
}
