/**
 * Poker baseline — the "book" brain behind decide() for 3-max no-limit
 * hold'em. Positional preflop chart (charts/preflop-3max.json) + a compact
 * hand-strength heuristic postflop + pot-odds calls.
 *
 * This chart plays roughly break-even against the house sims. That's the
 * hook: does your model beat the chart? Replace the decide() poker branch
 * with your own logic and find out.
 *
 * Guarantees the run loop leans on:
 *   - decidePoker() never returns an action outside the provided legal block.
 *   - Raise amounts are raise-TO totals clamped to [min_raise_to, max_raise_to].
 *   - withBudget() falls back to the chart action when your decide() overruns
 *     the act_deadline budget, so a slow model never times out a turn.
 */
import { readFileSync } from "node:fs";
import type { PokerActionName, PokerLegal, PokerMeView } from "./client.js";
import { handStrength, parseCard } from "./poker-eval.js";

// ---------------------------------------------------------------------------
// Chart (data-driven so you can tune ranges without touching code)
// ---------------------------------------------------------------------------

export type PokerPosition = "button" | "sb" | "bb";

export interface PreflopChart {
  open: Record<PokerPosition, { raiseToBB: number; range: string[] }>;
  threeBet: { sizeMultiplier: number; range: string[] };
  defend: Record<PokerPosition, { call: string[] }>;
}

function loadChart(): PreflopChart {
  const url = new URL("../charts/preflop-3max.json", import.meta.url);
  const raw = JSON.parse(readFileSync(url, "utf8"));
  return raw as PreflopChart;
}

/** The shipped 3-max chart. Loaded once at import. */
export const PREFLOP_CHART: PreflopChart = loadChart();

const RANK_ORDER = "23456789TJQKA";

/**
 * Canonical 169-combo class for two hole cards: "AA", "AKs", "AKo".
 * Accepts the wire card format ("AH", "TD", also "10D").
 */
export function handClass(hole: string[]): string {
  if (hole.length !== 2) throw new Error(`need exactly 2 hole cards, got ${hole.length}`);
  const a = parseCard(hole[0]);
  const b = parseCard(hole[1]);
  const rankChar = (r: number) => RANK_ORDER[r - 2];
  const [hi, lo] = a.rank >= b.rank ? [a, b] : [b, a];
  if (hi.rank === lo.rank) return rankChar(hi.rank) + rankChar(lo.rank);
  return rankChar(hi.rank) + rankChar(lo.rank) + (hi.suit === lo.suit ? "s" : "o");
}

/** Is a hand class inside a chart range? */
export function inRange(cls: string, range: string[]): boolean {
  return range.includes(cls);
}

/** Seat position relative to the button at 3-max. */
export function positionOf(seat: number, button: number, seatCount = 3): PokerPosition {
  const offset = ((seat - button) % seatCount + seatCount) % seatCount;
  return offset === 0 ? "button" : offset === 1 ? "sb" : "bb";
}

// ---------------------------------------------------------------------------
// Decision
// ---------------------------------------------------------------------------

export interface PokerDecision {
  move: PokerActionName;
  /** Raise-TO total; only set when move === "raise". */
  amount?: number;
  reason: string;
}

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, Math.round(v)));

/**
 * Constrain a wished-for action to the legal block. Downgrade order keeps the
 * intent: raise → call → check → fold; check ↔ fold as the safe floor.
 * This is also the last line of defense the tests pin: whatever comes in,
 * whatever the block says, the result is inside legal.actions.
 */
export function legalize(
  wish: PokerActionName,
  amount: number | undefined,
  legal: PokerLegal,
): { move: PokerActionName; amount?: number } {
  const has = (a: PokerActionName) => legal.actions.includes(a);
  const LADDERS: Record<PokerActionName, PokerActionName[]> = {
    raise: ["raise", "allin", "call", "check", "fold"],
    allin: ["allin", "raise", "call", "check", "fold"],
    call: ["call", "check", "fold"],
    // A wished-for check that's illegal means a bet arrived we never chose to
    // pay — fold rather than call money the strategy didn't sign off on.
    check: ["check", "fold"],
    fold: ["fold", "check"],
  };
  const ladder = LADDERS[wish];
  for (const m of ladder) {
    if (!has(m)) continue;
    if (m === "raise") {
      return { move: "raise", amount: clamp(amount ?? legal.min_raise_to, legal.min_raise_to, legal.max_raise_to) };
    }
    return { move: m };
  }
  // Empty/absent legal block (not our turn): fold is never wrong to *return*
  // — the runner only submits when it is actually our turn.
  return { move: "fold" };
}

/**
 * The chart baseline. state is the /me view (plus a legal override after an
 * illegal-action 400, if the runner is re-prompting).
 */
export function decidePoker(state: PokerMeView, legalOverride?: PokerLegal): PokerDecision {
  const legal = legalOverride ?? state.legal ?? { actions: [], to_call: 0, min_raise_to: 0, max_raise_to: 0 };
  const seat = state.my_seat ?? -1;
  const me = seat >= 0 ? state.seats[seat] : undefined;
  const hole = me?.hole ?? [];
  const pos = positionOf(seat, state.button, state.seats.length || 3);
  const bb = state.bb || 1;
  const toCall = legal.to_call;
  const pot = state.pot;

  const done = (wish: PokerActionName, amount: number | undefined, reason: string): PokerDecision => {
    const fitted = legalize(wish, amount, legal);
    const note = fitted.move === wish ? reason : `${reason}; ${wish} not legal → ${fitted.move}`;
    return { move: fitted.move, amount: fitted.amount, reason: note };
  };

  if (hole.length !== 2 || hole.includes("??")) {
    return done("check", undefined, "no readable hole cards — checking down");
  }
  const cls = handClass(hole);

  // ----- preflop: chart play -----
  if (state.street === "preflop") {
    const facingRaise = state.current_bet > bb;
    if (!facingRaise) {
      // Unopened pot (blinds only).
      const open = PREFLOP_CHART.open[pos];
      if (inRange(cls, open.range)) {
        return done("raise", open.raiseToBB * bb, `${cls} opens from ${pos} (chart, ${open.raiseToBB}BB)`);
      }
      if (toCall <= 0) return done("check", undefined, `${cls} not in the ${pos} open range — free check`);
      return done("fold", undefined, `${cls} not in the ${pos} open range`);
    }
    // Facing a raise.
    if (inRange(cls, PREFLOP_CHART.threeBet.range)) {
      const target = state.current_bet * PREFLOP_CHART.threeBet.sizeMultiplier;
      return done("raise", target, `${cls} 3-bets vs a raise (chart, ${PREFLOP_CHART.threeBet.sizeMultiplier}x)`);
    }
    if (inRange(cls, PREFLOP_CHART.defend[pos].call)) {
      // Pot-odds sanity: don't flat a raise that costs more than ~40% of pot+call.
      const price = toCall / (pot + toCall);
      if (price <= 0.4) return done("call", undefined, `${cls} defends ${pos} vs a raise (price ${price.toFixed(2)})`);
      return done("fold", undefined, `${cls} defends ${pos} but the price is too steep (${price.toFixed(2)})`);
    }
    if (toCall <= 0) return done("check", undefined, `${cls} closes the action for free`);
    return done("fold", undefined, `${cls} folds ${pos} vs a raise (chart)`);
  }

  // ----- postflop: hand strength vs pot odds -----
  const s = handStrength(hole, state.board);
  const strengthNote = `strength ${s.toFixed(2)} on ${state.street}`;

  if (toCall <= 0) {
    if (s >= 0.65) {
      return done("raise", state.current_bet + Math.max(0.66 * pot, bb), `value bet ~2/3 pot — ${strengthNote}`);
    }
    return done("check", undefined, `no bet to face — ${strengthNote}`);
  }

  const price = toCall / (pot + toCall); // pot odds: equity needed to call
  if (s >= 0.85) {
    return done("raise", state.current_bet + Math.max(0.75 * pot, bb), `raising for value — ${strengthNote}`);
  }
  if (s >= price + 0.08) {
    return done("call", undefined, `calling ${toCall} getting ${price.toFixed(2)} — ${strengthNote}`);
  }
  return done("fold", undefined, `${strengthNote} < pot odds ${price.toFixed(2)}`);
}

// ---------------------------------------------------------------------------
// Timing (§8.5 #30): act_deadline is authoritative; budget your model call.
// ---------------------------------------------------------------------------

/** Milliseconds left on the act clock; Infinity when no deadline is set. */
export function msRemaining(actDeadline: string | undefined, now: number = Date.now()): number {
  if (!actDeadline) return Number.POSITIVE_INFINITY;
  const t = Date.parse(actDeadline);
  if (Number.isNaN(t)) return Number.POSITIVE_INFINITY;
  return t - now;
}

/** Safety margin: your decision must land this long before the deadline. */
export const BUDGET_MARGIN_MS = 3000;

/**
 * Run fn (your decide()) against a time budget; if it overruns or throws,
 * take the fallback (the chart action) instead. Never rejects.
 */
export async function withBudget<T>(fn: () => Promise<T>, fallback: () => T, budgetMs: number): Promise<T> {
  if (!(budgetMs > 0)) return fallback();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<"__timeout__">((resolve) => {
    if (Number.isFinite(budgetMs)) timer = setTimeout(() => resolve("__timeout__"), budgetMs);
  });
  try {
    const winner = await Promise.race([fn(), timeout]);
    if (winner === "__timeout__") return fallback();
    return winner as T;
  } catch {
    return fallback();
  } finally {
    if (timer) clearTimeout(timer);
  }
}
