/**
 * Pins the decide() seam: the run loop depends on every decision being a
 * legal move plus optional reasoning fields within the documented limits
 * (reason ≤500 chars, confidence 0–1, source "llm" | "strategy").
 */
import { decide } from "../src/decide.js";
import { sanitizeReasoning } from "../src/client.js";
import type { RpsRound } from "../src/strategy.js";

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok || !detail ? "" : ` — ${detail}`}`);
  if (!ok) failures++;
}

const RPS_MOVES = ["rock", "paper", "scissors"];
const BJ_MOVES = ["hit", "stand", "double"];

// RPS: empty history and a streak both produce legal moves + honest labels.
{
  const d = await decide({ game: "rps", history: [] });
  check("rps decide returns a legal move on empty history", RPS_MOVES.includes(d.move));
  check("rps default is labeled source: strategy", d.source === "strategy");
  check("rps reason stays within 500 chars", !d.reason || d.reason.length <= 500);

  const streak: RpsRound[] = [
    { ours: "rock", theirs: "scissors", result: "win" },
    { ours: "rock", theirs: "scissors", result: "win" },
    { ours: "rock", theirs: "scissors", result: "win" },
  ];
  const d2 = await decide({ game: "rps", history: streak });
  check("rps decide returns a legal move with history", RPS_MOVES.includes(d2.move));
}

// Blackjack: chart spots — hard 20 stands, 11 doubles (and degrades to hit).
{
  const stand = await decide({ game: "blackjack", hand: ["KH", "QS"], dealerUp: "6D", canDouble: true });
  check("blackjack stands on hard 20", stand.move === "stand");

  const dbl = await decide({ game: "blackjack", hand: ["6H", "5S"], dealerUp: "6D", canDouble: true });
  check("blackjack doubles on 11 when legal", dbl.move === "double");

  const noDbl = await decide({ game: "blackjack", hand: ["6H", "5S"], dealerUp: "6D", canDouble: false });
  check("blackjack 11 degrades to hit when double is illegal", noDbl.move === "hit");

  check("blackjack default is labeled source: strategy", stand.source === "strategy");
  check(
    "blackjack moves are always legal",
    BJ_MOVES.includes(stand.move) && BJ_MOVES.includes(dbl.move) && BJ_MOVES.includes(noDbl.move),
  );
}

// sanitizeReasoning: the wire-side guardrails the loop relies on.
{
  const long = sanitizeReasoning({ reason: "x".repeat(900), confidence: 7, source: "strategy" });
  check("reason is trimmed to 500 chars", (long.reason as string).length === 500);
  check("confidence is clamped to 1", long.confidence === 1);
  const neg = sanitizeReasoning({ confidence: -3 });
  check("confidence is clamped to 0", neg.confidence === 0);
  const none = sanitizeReasoning(undefined);
  check("no reasoning → empty extras (bare move body)", Object.keys(none).length === 0);
  const bad = sanitizeReasoning({ source: "human" as never });
  check("unknown source values are dropped", bad.source === undefined);
}

if (failures > 0) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log("\nall checks passed");
