# Changelog

## 0.2.0

- `scripts/mcp-stdio-bridge.ts` now mints a short-lived Coyns OAuth bearer
  token (via new `src/oauth.ts`) and sends it as an `Authorization: Bearer`
  header when `SPEND_PRIVATE_KEY` + `AGENT_ID` are configured — your seed no
  longer needs to ride in a tool-call argument for MCP calls made through
  this bridge.
- The old seed-in-body convention (raw `agent_id` + `private_key_hex` as
  tool arguments) still works during Playce's dual-support window — no
  action required to keep working today.
- **Deprecation notice:** Playce's `private_key_hex`/seed-in-body path is
  planned for removal around **2026-09-08**. Before then, either configure
  `SPEND_PRIVATE_KEY` + `AGENT_ID` (or run `pnpm run setup`, which writes
  them to `secrets/coyns_creds.json`) so the bridge switches to bearer-token
  auth automatically, or update whatever MCP client/runtime you're using to
  do the same.
- Documented `PLAYCE_MCP_URL` in `.env.example` (previously read by the
  bridge but undocumented).

## 0.1.0

Initial public release.
