/**
 * Pins the poker seam the run loop depends on:
 *   - chart lookups (hand classes, positions, ranges)
 *   - decidePoker() legality: never an action outside the provided legal
 *     block, raise amounts always inside [min_raise_to, max_raise_to]
 *   - the illegal-action 400 envelope parser (pokerIllegal)
 *   - the act_deadline budget helper (msRemaining / withBudget)
 *   - the 7-card evaluator ordering
 */
import { pokerIllegal, normalizePokerAction, type PokerActionName, type PokerLegal, type PokerMeView } from "../src/client.js";
import { evaluateHand, handStrength } from "../src/poker-eval.js";
import {
  PREFLOP_CHART,
  handClass,
  inRange,
  positionOf,
  legalize,
  decidePoker,
  msRemaining,
  withBudget,
} from "../src/poker-strategy.js";

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok || !detail ? "" : ` — ${detail}`}`);
  if (!ok) failures++;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// ---- chart lookups ----
{
  check("handClass: suited broadway", handClass(["AH", "KH"]) === "AKs");
  check("handClass: offsuit, order-independent", handClass(["KD", "AH"]) === "AKo");
  check("handClass: pocket pair", handClass(["7C", "7D"]) === "77");
  check("handClass: ten as T", handClass(["10D", "9D"]) === "T9s");

  check("AA opens from every position",
    (["button", "sb", "bb"] as const).every((p) => inRange("AA", PREFLOP_CHART.open[p].range)));
  check("button opens wider than sb",
    PREFLOP_CHART.open.button.range.length > PREFLOP_CHART.open.sb.range.length);
  check("button open size is 2.5BB", PREFLOP_CHART.open.button.raiseToBB === 2.5);
  check("72o opens nowhere",
    (["button", "sb", "bb"] as const).every((p) => !inRange("72o", PREFLOP_CHART.open[p].range)));
  check("QQ is a 3-bet", inRange("QQ", PREFLOP_CHART.threeBet.range));
  check("BB defends suited connectors vs a raise", inRange("76s", PREFLOP_CHART.defend.bb.call));

  check("positionOf: button", positionOf(2, 2) === "button");
  check("positionOf: sb left of button (wraps)", positionOf(0, 2) === "sb");
  check("positionOf: bb", positionOf(1, 2) === "bb");
}

// ---- evaluator ordering ----
{
  const sf = evaluateHand(["9H", "8H", "7H", "6H", "5H", "AD", "AC"]);
  const quads = evaluateHand(["AS", "AH", "AD", "AC", "KH", "2C", "3D"]);
  check("straight flush beats quads", sf.score > quads.score, `${sf.category} vs ${quads.category}`);

  const wheel = evaluateHand(["AH", "2D", "3C", "4S", "5H", "KD", "QC"]);
  check("wheel counts as a straight", wheel.category === "straight" && wheel.tiebreak[0] === 5);

  const twoPairHi = evaluateHand(["AH", "AD", "KC", "KS", "2H", "7D", "9C"]);
  const twoPairLo = evaluateHand(["QH", "QD", "JC", "JS", "AH", "7D", "9C"]);
  check("two pair tiebreaks on the top pair", twoPairHi.score > twoPairLo.score);

  check("strength: nut flush grades high", handStrength(["AH", "KH"], ["QH", "7H", "2H"]) >= 0.8);
  check("strength: stone-cold air grades low", handStrength(["7C", "2D"], ["AH", "KS", "9H"]) <= 0.3);
}

// ---- legality: decidePoker never leaves the legal block ----
function meView(overrides: Partial<PokerMeView>): PokerMeView {
  return {
    match_id: "pk_test", table_id: "pk_bronze_1",
    phase: "in_hand", street: "preflop", board: [], button: 0, sb: 1, bb: 2,
    to_act: 0, current_bet: 2, min_raise_to: 4, saw_flop: false, pot: 3,
    seats: [
      { agent: "me", status: "active", stack: 98, committed: 0, street_bet: 0, revealed: false, hole: ["AH", "KH"] },
      { agent: "villain1", status: "active", stack: 99, committed: 1, street_bet: 1, revealed: false, hole: ["??", "??"] },
      { agent: "villain2", status: "active", stack: 98, committed: 2, street_bet: 2, revealed: false, hole: ["??", "??"] },
    ],
    my_seat: 0,
    legal: { actions: ["fold", "call", "raise", "allin"], to_call: 2, min_raise_to: 4, max_raise_to: 100 },
    hand_state: "in_hand",
    ...overrides,
  };
}

{
  const blocks: PokerLegal[] = [
    { actions: ["fold", "call", "raise", "allin"], to_call: 2, min_raise_to: 4, max_raise_to: 100 },
    { actions: ["fold", "check", "raise", "allin"], to_call: 0, min_raise_to: 4, max_raise_to: 100 },
    { actions: ["fold", "call"], to_call: 50, min_raise_to: 0, max_raise_to: 0 }, // raise barred
    { actions: ["fold", "call", "allin"], to_call: 10, min_raise_to: 0, max_raise_to: 12 },
    { actions: ["fold", "check"], to_call: 0, min_raise_to: 0, max_raise_to: 0 },
  ];
  const holes = [["AH", "AD"], ["7C", "2D"], ["9H", "8H"], ["KD", "QD"]];
  const streets: { street: PokerMeView["street"]; board: string[] }[] = [
    { street: "preflop", board: [] },
    { street: "flop", board: ["QH", "7H", "2C"] },
    { street: "river", board: ["QH", "7H", "2C", "3D", "9S"] },
  ];
  let allLegal = true;
  let amountsOk = true;
  for (const legal of blocks) {
    for (const hole of holes) {
      for (const { street, board } of streets) {
        const view = meView({ street, board, current_bet: legal.to_call, legal });
        view.seats[0].hole = hole;
        const d = decidePoker(view);
        if (!legal.actions.includes(d.move)) {
          allLegal = false;
          console.log(`  ILLEGAL: ${d.move} with block [${legal.actions}] hole ${hole} ${street}`);
        }
        if (d.move === "raise") {
          if (d.amount === undefined || d.amount < legal.min_raise_to || d.amount > legal.max_raise_to) amountsOk = false;
        } else if (d.amount !== undefined) {
          amountsOk = false;
        }
      }
    }
  }
  check("decidePoker never returns an action outside the legal block", allLegal);
  check("raise amounts stay inside [min_raise_to, max_raise_to] (and only on raises)", amountsOk);

  // The legal override (re-prompt path) is honored over the stale view block.
  const view = meView({});
  const stricter: PokerLegal = { actions: ["fold", "call"], to_call: 2, min_raise_to: 0, max_raise_to: 0 };
  const d = decidePoker(view, stricter);
  check("legal override (re-prompt block) is honored", stricter.actions.includes(d.move));

  // legalize(): a wished-for check facing a bet folds rather than pays.
  const fitted = legalize("check", undefined, { actions: ["fold", "call"], to_call: 10, min_raise_to: 0, max_raise_to: 0 });
  check("legalize downgrades an illegal check to fold, not call", fitted.move === "fold");

  // Chart spots behave: AKs opens the button; 72o folds to a raise.
  const open = decidePoker(meView({}));
  check("AKs raises from the button preflop", open.move === "raise" && open.amount === 5, JSON.stringify(open));
  const trash = meView({ current_bet: 6, pot: 9 });
  trash.seats[0].hole = ["7C", "2D"];
  trash.legal = { actions: ["fold", "call", "raise", "allin"], to_call: 6, min_raise_to: 10, max_raise_to: 100 };
  check("72o folds to a raise", decidePoker(trash).move === "fold");
}

// ---- client envelope parsing ----
{
  const env = pokerIllegal({
    status: 400,
    data: {
      error: "illegal_action",
      detail: "poker: raise below minimum raise-to",
      legal: { actions: ["fold", "call", "raise", "allin"], to_call: 4, min_raise_to: 8, max_raise_to: 96 },
    },
  });
  check("pokerIllegal parses the 400 envelope", env !== null && env.detail.includes("raise below"));
  check("pokerIllegal exposes the typed legal block", env?.legal.min_raise_to === 8 && env?.legal.actions.length === 4);

  check("pokerIllegal ignores other 400s", pokerIllegal({ status: 400, data: { error: "action required" } }) === null);
  check("pokerIllegal ignores non-400s", pokerIllegal({ status: 429, data: { error: "too many illegal actions" } }) === null);
  check("pokerIllegal tolerates a malformed legal block",
    pokerIllegal({ status: 400, data: { error: "illegal_action", detail: "x" } })?.legal.actions.length === 0);

  check("allIn normalizes to the wire's allin", normalizePokerAction("allIn") === "allin");
  check("wire actions pass through normalize", (["fold", "check", "call", "raise", "allin"] as PokerActionName[])
    .every((a) => normalizePokerAction(a) === a));
}

// ---- budget helper ----
{
  const now = Date.now();
  const in10s = new Date(now + 10_000).toISOString();
  const left = msRemaining(in10s, now);
  check("msRemaining reads an ISO deadline", left > 9_900 && left <= 10_000, String(left));
  check("msRemaining is Infinity without a deadline", msRemaining(undefined) === Number.POSITIVE_INFINITY);
  check("msRemaining is negative past the deadline", msRemaining(new Date(now - 5_000).toISOString(), now) < 0);

  const fast = await withBudget(async () => "model", () => "chart", 5_000);
  check("withBudget returns the fn result inside budget", fast === "model");

  const slow = await withBudget(async () => { await sleep(300); return "model"; }, () => "chart", 50);
  check("withBudget falls back when fn overruns", slow === "chart");

  const thrown = await withBudget(async () => { throw new Error("model exploded"); }, () => "chart", 5_000);
  check("withBudget falls back when fn throws", thrown === "chart");

  const spent = await withBudget(async () => "model", () => "chart", -100);
  check("withBudget takes the fallback immediately on a spent clock", spent === "chart");

  const unbounded = await withBudget(async () => "model", () => "chart", Number.POSITIVE_INFINITY);
  check("withBudget runs unbounded with an infinite budget", unbounded === "model");
}

if (failures > 0) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log("\nall checks passed");
