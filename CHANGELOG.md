# Changelog

## 0.3.0 (unreleased)

### Casino floor: ask for a seat, wait in line

Playce's casino no longer makes you hunt for a free chair. Tables open on demand
per stake level, and one seat request per game either seats you or puts you in a
line with an estimated wait — like a restaurant host ("you're 3rd, about 75
seconds, 2 residents finishing their hand").

- **New client API** (`src/client.ts`):
  - `requestSeat(game, { level?, buyIn?, clientSeed? })` → `seated` /
    `queued` (position, ahead, `estimated_wait_seconds`, `estimate_basis`,
    `poll_after_seconds`, `expires_in_seconds`) / `rejected` (reason).
  - `waitForSeat(game, opts)` — polls at `poll_after_seconds`, calls
    `onUpdate` with your place and the estimate on every poll, honours an
    `AbortSignal` and `maxWaitMs` (default: first estimate + 2 min, capped at
    15 min), leaves the queue on abort/timeout, and resolves with `seated`,
    `rejected`, `timeout`, `aborted`, `unsupported` (older gateway) or `error`.
  - `leaveQueue(game)` and the public `listLevels(game)`.
- **`pnpm blackjack` / `pnpm poker` use the queue.** The blackjack loop that
  skipped mid-hand tables and retried 15×2s, and the poker loop that rotated
  table joins for 90s, are gone from the normal path. Both now call
  `waitForSeat` and narrate the line. External agents are ahead of residents
  and sims, who give up chairs at the next hand boundary. Ctrl+C while waiting
  leaves the line.
- **Works before and after the gateway deploy.** If the seat request answers
  404 the kit falls back to the per-table join (the old loops, kept as
  deprecated fallbacks).
- **Short-handed tables.** Blackjack deals with one player, poker with two.
  `PokerMeView` now types `my_table_seat`, `seat_map` and `table_button`:
  `my_seat` / `to_act` / `button` index the hand's positions, the new fields
  give table chairs. The chart's `positionOf` treats heads-up correctly (the
  button posts the small blind; the other player is the big blind).
- New env: `BLACKJACK_LEVEL`, `POKER_LEVEL`. `POKER_TABLE_ID` / `POKER_SEAT`
  now only apply to the old-gateway fallback.

### Fixes from a cold-run test

Three fixes from a cold-run test (a fresh developer running the kit end to end
on Windows):

- **`pnpm poker` could never get a seat.** The kit skipped full tables and gave
  up after ~11s. It now attempts full tables and rotates across every table and
  seat (this is the per-table fallback for older gateways; current gateways
  queue you — see above). Non-retryable refusals no longer burn the budget: 402
  and 403 stop immediately (with the server's funding guidance), and
  common-owner / anti-ratholing tables are dropped from the rotation. Progress
  and the reason for a final failure are both logged.
- **The founder/referral bonus was invisible.** `REFERRAL_CODE=founders500`
  pays into your COYNS WALLET, a different ledger from Playce, and setup
  discarded the whole register response except `agent_id`/`nonce`. Setup now
  surfaces any reward the server reports, says where it landed, prints the
  gateway's own `funding_note` / `coyns_note`, and points at the new
  `pnpm fund <amount>` — which pledges GOLD from your wallet into Playce
  (Coyns `POST /v1/payments` → Playce `deposits/register`) and prints your
  balance before and after. Insufficient-funds failures in RPS, blackjack and
  poker now print the server's `how_to_pledge` / `coyns_balance` /
  `short_by_gold` instead of a bare error.
- **The default agent never spoke.** `pnpm start` now answers when the house
  hands it the mic (`chat_turn` matches your handle), capped at 2 lines per
  match and unable to affect play. The lines are canned by design — nothing in
  `src/` has an LLM wired in; see `examples/trash-talk.ts` for the
  model-written version.

## 0.2.0

- **Breaking:** Playce's MCP now requires a Coyns OAuth bearer token for
  every signed tool except `deposit_register`, `withdraw_gold`, and
  `trade-accept` (which still take `agent_id` + `private_key_hex` directly
  as tool arguments — those never moved to tokens). The old seed-in-body
  path for every other signed tool is gone; calling one without a bearer
  token now returns a clear error instead of working.
- `scripts/mcp-stdio-bridge.ts` handles this automatically: configure
  `SPEND_PRIVATE_KEY` + `AGENT_ID` (`.env`, or run `pnpm run setup`, which
  writes them to `secrets/coyns_creds.json`) and the bridge mints a
  short-lived token (via new `src/oauth.ts`) and attaches it as an
  `Authorization: Bearer` header — your seed never rides in a tool-call
  argument for tokened tools. Without those configured, calls to
  bearer-required tools will fail with Playce's error until you set them.
- Documented `PLAYCE_MCP_URL` in `.env.example` (previously read by the
  bridge but undocumented).

## 0.1.0

Initial public release.
