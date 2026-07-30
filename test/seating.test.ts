/**
 * Pins the poker seat-claim contract the gateway publishes in `seating_note`
 * (gateway/internal/http/handlers/casino_poker.go):
 *
 *   "a join that returns 409 'seat taken' records your interest, and a seat is
 *    freed for you at the next hand boundary … reserved for you ~45s. So a full
 *    table can still be joined, but only by attempting the join."
 *
 * The kit used to skip full tables and give up in ~11s, which made `pnpm poker`
 * unreachable on a room whose tables are kept occupied by resident agents. These
 * checks lock in the two halves of the fix:
 *
 *   1. seatCandidates never drops an occupied seat (it only deprioritizes it).
 *   2. classifySeatClaim keeps trying on the 409s that record interest, retires
 *      only the permanently-refusing tables, and stops dead on account-level
 *      walls (402 / 403) instead of burning the retry budget.
 *
 * Also asserts the budget itself outlives the server's ~45s reservation hold.
 */
import {
  SEAT_CLAIM_BUDGET_MS,
  classifySeatClaim,
  pickChatLine,
  seatCandidates,
  seatFromEnv,
  serverMessage,
  type SeatVerdict,
} from "../src/index.js";
import type { PokerTable } from "../src/client.js";

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok || !detail ? "" : ` — ${detail}`}`);
  if (!ok) failures++;
}

function table(id: string, occupants: number[], over: Partial<PokerTable> = {}): PokerTable {
  return {
    table_id: id,
    name: id,
    seats: 3,
    small_blind: 1,
    big_blind: 2,
    min_buyin: 100,
    max_buyin: 400,
    rake_bps: 0,
    rake_cap: 0,
    clock_seconds: 30,
    phase: occupants.length >= 3 ? "in_hand" : "waiting",
    seated: occupants.length,
    occupants: occupants.map((seat) => ({ seat, agent: `resident_${seat}`, stack: 200 })),
    button: 0,
    ...over,
  };
}

// ---- 1. candidate rotation ----

const full = table("t_full", [0, 1, 2]);
const partial = table("t_partial", [1]);

const fullOnly = seatCandidates([full]);
check(
  "a FULL table still yields all 3 seats (a 409 is the documented way in)",
  fullOnly.length === 3 && fullOnly.every((c) => c.tableId === "t_full"),
  JSON.stringify(fullOnly),
);

const both = seatCandidates([full, partial]);
check("both tables are in the rotation, every seat", both.length === 6, `got ${both.length}`);
check(
  "free seats are attempted before occupied ones",
  both[0].tableId === "t_partial" && [0, 2].includes(both[0].seat) &&
    both[1].tableId === "t_partial" && [0, 2].includes(both[1].seat),
  JSON.stringify(both.slice(0, 3)),
);
check(
  "occupied seats are deprioritized, NOT dropped",
  both.filter((c) => c.tableId === "t_full").length === 3 &&
    both.some((c) => c.tableId === "t_partial" && c.seat === 1),
);

check(
  "buy-in defaults to min_buyin and is clamped into the table's range",
  seatCandidates([partial])[0].buyIn === 100 &&
    seatCandidates([partial], { buyInEnv: "9999" })[0].buyIn === 400 &&
    seatCandidates([partial], { buyInEnv: "5" })[0].buyIn === 100 &&
    seatCandidates([partial], { buyInEnv: "not-a-number" })[0].buyIn === 100,
);

const pinned = seatCandidates([full, partial], { wantSeat: 2 });
check(
  "POKER_SEAT pins one seat per table",
  pinned.length === 2 && pinned.every((c) => c.seat === 2),
  JSON.stringify(pinned),
);

// `POKER_SEAT=` ships blank in .env.example. Number("") is 0, which would have
// pinned every run to seat 0 and quietly undone the rotation above.
check(
  "a blank/garbage POKER_SEAT means ANY seat, not seat 0",
  seatFromEnv("") === -1 &&
    seatFromEnv(undefined) === -1 &&
    seatFromEnv("  ") === -1 &&
    seatFromEnv("x") === -1 &&
    seatFromEnv("-1") === -1 &&
    seatFromEnv("0") === 0 &&
    seatFromEnv("2") === 2,
);

// ---- 2. response classification ----

const cases: Array<[string, number, unknown, SeatVerdict]> = [
  ["200 join", 200, { joined: true }, "seated"],
  [
    "409 seat taken (interest recorded)",
    409,
    { error: "seat taken. Your interest is recorded: a seat is freed for you at the next hand boundary (usually a few seconds), reserved ~45s. Retry if you want it — no obligation." },
    "keep-trying",
  ],
  [
    "409 hand in progress (interest recorded)",
    409,
    { error: "a hand is in progress. Your interest is recorded: a seat frees at the next hand boundary (usually a few seconds), reserved ~45s." },
    "keep-trying",
  ],
  ["409 casino reconciling", 409, { error: "casino: reconciling a stalled settlement — try again shortly" }, "keep-trying"],
  ["429 rate limited", 429, { error: "slow down" }, "keep-trying"],
  ["503 gateway hiccup", 503, { error: "poker not configured" }, "keep-trying"],
  [
    "409 common owner (permanent for this table)",
    409,
    { error: "poker: an agent with the same creator is already seated at this table" },
    "table-hopeless",
  ],
  [
    "409 anti-ratholing (permanent for this tier)",
    409,
    { error: "poker: rejoining this tier within 60 minutes requires re-entering with your departing stack: buy in for at least 240" },
    "table-hopeless",
  ],
  ["409 already seated → we're in", 409, { error: "casino: agent already seated at this table" }, "seated"],
  ["400 buy-in out of range", 400, { error: "casino: buy-in outside the table range" }, "table-hopeless"],
  [
    "402 insufficient balance → stop, don't burn the budget",
    402,
    { error: "insufficient balance for this buy-in", how_to_pledge: "send GOLD to @playce_house" },
    "stop",
  ],
  ["403 no registered creator → stop", 403, { error: "poker seats require a registered creator" }, "stop"],
];

for (const [name, status, data, want] of cases) {
  const got = classifySeatClaim({ status, data });
  check(`classify ${name} → ${want}`, got.verdict === want, `got ${got.verdict}`);
}

check(
  "the server's message is surfaced, not swallowed",
  classifySeatClaim({ status: 409, data: { error: "seat taken. Your interest is recorded" } }).message ===
    "seat taken. Your interest is recorded",
);

// ---- 3. budget outlives the reservation window ----

check(
  `claim budget (${SEAT_CLAIM_BUDGET_MS}ms) outlives the server's ~45s reservation hold`,
  SEAT_CLAIM_BUDGET_MS >= 60_000,
  `${SEAT_CLAIM_BUDGET_MS}ms`,
);

// ---- 4. odds and ends ----

check(
  "serverMessage reads {error}, {error:{message}}, {detail} and plain strings",
  serverMessage({ error: "a" }) === "a" &&
    serverMessage({ error: { message: "b" } }) === "b" &&
    serverMessage({ detail: "c" }) === "c" &&
    serverMessage("d") === "d" &&
    serverMessage(null) === "",
);

const spoken = [0, 1, 2, 3, 4, 5, 6, 7].map(pickChatLine);
check(
  "chat lines rotate, wrap, and stay inside sendChat's 120-char cap",
  new Set(spoken).size > 1 &&
    spoken.every((l) => l.length > 0 && l.length <= 120) &&
    pickChatLine(-1).length > 0,
  JSON.stringify(spoken),
);

if (failures > 0) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log("\nall checks passed");
