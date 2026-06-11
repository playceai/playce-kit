/**
 * Pins the replay log's pure helpers: perspective math (opponent, result,
 * GOLD delta) and the honest decision-line formatter. The network paths are
 * exercised manually against a live gateway (`pnpm replay <match_id>`).
 */
import {
  opponentOf,
  resultFor,
  goldDelta,
  tPlus,
  formatDecision,
  type ReplayMatch,
  type DecisionRow,
} from "../src/replay.js";

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok || !detail ? "" : ` — ${detail}`}`);
  if (!ok) failures++;
}

const settled: ReplayMatch = {
  match_id: "m1",
  state: "SETTLED",
  room_id: "pit",
  agent_a: "me",
  agent_b: "them",
  stake: 1,
  choice_a: "paper",
  choice_b: "rock",
  result: "A",
  active_started_at: "2026-06-10T00:00:00Z",
  settled_at: "2026-06-10T00:01:00Z",
};

// Perspective math — both seats, draw, and a spectator.
{
  check("opponent from seat A", opponentOf(settled, "me") === "them");
  check("opponent from seat B", opponentOf(settled, "them") === "me");
  check("opponent for a non-participant is empty", opponentOf(settled, "ghost") === "");

  check("winner sees win", resultFor(settled, "me") === "win");
  check("loser sees loss", resultFor(settled, "them") === "loss");
  check("draw reads draw", resultFor({ ...settled, result: "DRAW" }, "me") === "draw");
  check("unrevealed result reads pending", resultFor({ ...settled, result: undefined }, "me") === "pending");

  check("win delta is +stake", goldDelta(settled, "me") === 1);
  check("loss delta is -stake", goldDelta(settled, "them") === -1);
  check("draw delta is 0", goldDelta({ ...settled, result: "DRAW" }, "me") === 0);
  check("pending delta is null", goldDelta({ ...settled, result: undefined }, "me") === null);
}

// Time-in-window offsets.
{
  check("t+ offset renders", tPlus("2026-06-10T00:00:02.100Z", "2026-06-10T00:00:00Z") === "t+2.1s");
  check("t+ empty without a start time", tPlus("2026-06-10T00:00:02Z") === "");
  check("t+ tolerates junk timestamps", tPlus("not-a-date", "2026-06-10T00:00:00Z") === "");
}

// The decision line prints exactly what the API returned — no invention.
{
  const full: DecisionRow = {
    agent_name: "me",
    seq: 1,
    move: "paper",
    reason: "opponent opened rock twice",
    confidence: 0.7,
    source: "strategy",
    ts: "2026-06-10T00:00:02.100Z",
  };
  const line = formatDecision(full, "2026-06-10T00:00:00Z");
  check("decision line carries t+, agent, move, reason, conf, source",
    line.includes("t+2.1s") && line.includes("@me") && line.includes("paper") &&
    line.includes('reason="opponent opened rock twice"') && line.includes("conf=0.7") &&
    line.includes("source=strategy"));

  const bare: DecisionRow = {
    agent_name: "them", seq: 1, move: "rock",
    reason: null, confidence: null, source: "none", ts: "2026-06-10T00:00:03Z",
  };
  const bareLine = formatDecision(bare, "2026-06-10T00:00:00Z");
  check("bare decision omits reason/conf/source instead of inventing them",
    !bareLine.includes("reason=") && !bareLine.includes("conf=") && !bareLine.includes("source="));
}

if (failures > 0) {
  console.error(`\n${failures} failure(s)`);
  process.exit(1);
}
console.log("\nreplay tests passed");
