/**
 * stdio ↔ HTTP bridge for the Playce MCP endpoint.
 *
 * The Playce MCP server speaks plain JSON-RPC 2.0 over HTTP POST — no SSE,
 * no streamable-HTTP session headers. MCP clients that only speak stdio
 * (Claude Desktop, and Claude Code's stdio transport) can run this script
 * as their "server": it pipes each newline-delimited JSON-RPC message from
 * stdin to the HTTP endpoint and writes the response back to stdout.
 *
 *   PLAYCE_MCP_URL  endpoint to bridge to (default https://api.playce.ai/mcp)
 *
 * Claude Desktop config (claude_desktop_config.json):
 *   {
 *     "mcpServers": {
 *       "playce": {
 *         "command": "npx",
 *         "args": ["-y", "tsx", "/absolute/path/to/scripts/mcp-stdio-bridge.ts"]
 *       }
 *     }
 *   }
 *
 * Notifications (messages without an id, e.g. notifications/initialized) are
 * forwarded but produce no stdout line — the server returns an empty body for
 * them, and JSON-RPC notifications must not get responses.
 *
 * Auth: if SPEND_PRIVATE_KEY + AGENT_ID are configured (.env, or the creds
 * `pnpm setup` saved), this bridge mints a short-lived Coyns OAuth bearer
 * token and attaches it as an Authorization header — your seed never rides
 * in a tool-call argument. This is required for every signed tool except
 * deposit_register/withdraw_gold/trade-accept, which still take agent_id +
 * private_key_hex directly as tool arguments (Playce removed the tool-argument
 * path for every other signed tool on 2026-07-25). Either way: server-side
 * runtimes only, never paste your seed into a browser or a shared chat.
 */
import { createInterface } from "node:readline";
import { getCachedToken, invalidateCachedToken } from "../src/oauth.js";
import { loadSavedCreds } from "../src/index.js";

const URL = process.env.PLAYCE_MCP_URL || "https://api.playce.ai/mcp";

// .env wins; otherwise fall back to the creds `pnpm setup` saved — same
// resolution order src/index.ts's main() uses.
const saved = loadSavedCreds();
const AGENT_ID = process.env.AGENT_ID || saved.agent_id || "";
const SPEND_PRIVATE_KEY = process.env.SPEND_PRIVATE_KEY || saved.spend_private || "";

const write = (obj: unknown) => process.stdout.write(JSON.stringify(obj) + "\n");

/**
 * Mint/refresh a bearer token if local creds are configured; null otherwise.
 *
 * Playce removed the agent_id + private_key_hex tool-argument path for every
 * bearer-eligible tool on 2026-07-25 — without local creds, calls to those
 * tools now get a clear "Authorization: Bearer <token> is required" error
 * straight from Playce, since this bridge has nothing to attach. A few
 * value-moving tools (deposit_register, withdraw_gold, trade-accept) still
 * take agent_id + private_key_hex directly as tool arguments regardless —
 * that path was never routed through this bridge's token logic, so it keeps
 * working via plain passthrough whether or not local creds are configured.
 */
async function ensureToken(): Promise<string | null> {
  if (!AGENT_ID || !SPEND_PRIVATE_KEY) return null;
  try {
    const privateKey = Uint8Array.from(Buffer.from(SPEND_PRIVATE_KEY, "base64"));
    const { token } = await getCachedToken({ agentId: AGENT_ID, privateKey });
    return token;
  } catch (e) {
    console.error(`bridge: token mint failed: ${String(e)}`);
    return null;
  }
}

async function postToPlayce(line: string, token: string | null): Promise<Response> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (token) headers.authorization = `Bearer ${token}`;
  // body is always the raw line, unchanged — deposit_register/withdraw_gold/
  // trade-accept still take agent_id + private_key_hex as tool arguments
  // directly (never via a header this bridge injects).
  return fetch(URL, { method: "POST", headers, body: line });
}

async function forward(line: string): Promise<void> {
  let msg: { id?: unknown; method?: string };
  try {
    msg = JSON.parse(line);
  } catch {
    return; // not JSON — ignore rather than corrupt the stream
  }
  const isNotification = msg.id === undefined || msg.id === null;
  try {
    let token = await ensureToken();
    let res = await postToPlayce(line, token);
    if (res.status === 401 && token) {
      // Token may have expired/been revoked early — re-mint once and retry.
      invalidateCachedToken();
      token = await ensureToken();
      res = await postToPlayce(line, token);
    }
    const text = (await res.text()).trim();
    if (isNotification) return; // no response allowed for notifications
    if (text) {
      // Server response is already a JSON-RPC envelope; relay verbatim.
      process.stdout.write(text.replace(/\r?\n/g, "") + "\n");
    } else {
      write({ jsonrpc: "2.0", id: msg.id, error: { code: -32603, message: `empty response (HTTP ${res.status})` } });
    }
  } catch (e) {
    if (!isNotification) {
      write({ jsonrpc: "2.0", id: msg.id, error: { code: -32603, message: `bridge: ${String(e)}` } });
    }
  }
}

// Process stdin lines strictly in order — MCP clients may pipeline requests.
let queue: Promise<void> = Promise.resolve();
const rl = createInterface({ input: process.stdin, terminal: false });
rl.on("line", (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  queue = queue.then(() => forward(trimmed));
});
rl.on("close", () => {
  queue.then(() => process.exit(0));
});
