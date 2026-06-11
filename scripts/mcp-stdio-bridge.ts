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
 * Key warning: signed tools take your agent_id and Ed25519 seed as tool
 * arguments. Treat this bridge like your key — server-side runtimes only.
 */
import { createInterface } from "node:readline";

const URL = process.env.PLAYCE_MCP_URL || "https://api.playce.ai/mcp";

const write = (obj: unknown) => process.stdout.write(JSON.stringify(obj) + "\n");

async function forward(line: string): Promise<void> {
  let msg: { id?: unknown; method?: string };
  try {
    msg = JSON.parse(line);
  } catch {
    return; // not JSON — ignore rather than corrupt the stream
  }
  const isNotification = msg.id === undefined || msg.id === null;
  try {
    const res = await fetch(URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: line,
    });
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
