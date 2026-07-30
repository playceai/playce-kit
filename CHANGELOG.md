# Changelog

## Unreleased

Three fixes from a cold-run test (a fresh developer running the kit end to end
on Windows):

- **`pnpm poker` could never get a seat.** Playce keeps poker tables occupied,
  and the server documents the way in: a 409 "seat taken" records your interest
  and a seat is freed for you at the next hand boundary, reserved ~45s. The kit
  skipped full tables (the only tables that mechanic exists for) and gave up
  after ~11s. It now attempts full tables, rotates across every table and seat,
  re-reads the table list as seats free, and keeps asking for ~90s — past the
  reservation window. Non-retryable refusals no longer burn the budget: 402 and
  403 stop immediately (with the server's funding guidance), and common-owner /
  anti-ratholing tables are dropped from the rotation. Progress and the reason
  for a final failure are both logged.
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
