/**
 * Pins the casino-floor seat request (Playce docs/casino-floor-spec.md §4):
 * one POST .../{game}/seat that answers seated / queued / rejected, a queue you
 * keep by polling at `poll_after_seconds`, and DELETE .../seat to step out.
 *
 * fetch is mocked and waitForSeat gets a fake clock, so these run instantly and
 * never touch the network.
 */
import { randomBytes } from "node:crypto";
import {
  PlayceClient,
  alreadySeatedTable,
  defaultSeatWaitMs,
  type SeatQueueUpdate,
} from "../src/client.js";
import { describeQueue, describeWait } from "../src/index.js";

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok || !detail ? "" : ` — ${detail}`}`);
  if (!ok) failures++;
}

type Call = { method: string; path: string; body: any };
type Reply = { status: number; body: unknown } | ((call: Call) => { status: number; body: unknown });

/** Route mocked replies by "METHOD path"; each route replays its list, repeating the last entry. */
function mockFetch(routes: Record<string, Reply[]>): Call[] {
  const calls: Call[] = [];
  const cursor: Record<string, number> = {};
  (globalThis as any).fetch = async (url: string, init: { method: string; body?: string }) => {
    const path = new URL(url).pathname;
    const call: Call = { method: init.method, path, body: init.body ? JSON.parse(init.body) : undefined };
    calls.push(call);
    const key = `${init.method} ${path}`;
    const list = routes[key];
    if (!list) return new Response("404 page not found", { status: 404 });
    const i = Math.min(cursor[key] ?? 0, list.length - 1);
    cursor[key] = (cursor[key] ?? 0) + 1;
    const r = list[i];
    const { status, body } = typeof r === "function" ? r(call) : r;
    return new Response(typeof body === "string" ? body : JSON.stringify(body), { status });
  };
  return calls;
}

function fakeClock() {
  let t = 1_000_000;
  const sleeps: number[] = [];
  return {
    sleeps,
    now: () => t,
    advance: (ms: number) => { t += ms; },
    sleep: async (ms: number, signal?: AbortSignal) => {
      sleeps.push(ms);
      if (!signal?.aborted) t += ms;
    },
  };
}

function client(): PlayceClient {
  const c = new PlayceClient("https://playce.test");
  c.setCreds({ agentId: "agt_test", privateKey: new Uint8Array(randomBytes(32)), agentName: "tester" });
  return c;
}

const SEAT = "/v1/playce/halls/casino/blackjack/seat";
const PSEAT = "/v1/playce/halls/casino/poker/seat";

const queued = (position: number, est: number, over: Record<string, unknown> = {}) => ({
  status: 200,
  body: {
    status: "queued", level: "low", position, ahead: position - 1,
    estimated_wait_seconds: est, estimate_basis: `${position - 1} residents finishing their hand`,
    poll_after_seconds: 10, expires_in_seconds: 60, ...over,
  },
});
const seated = { status: 200, body: { status: "seated", table_id: "bj_aurum_3", seat: 1 } };

// ---- requestSeat / leaveQueue / listLevels wire shapes ----
{
  const calls = mockFetch({
    [`POST ${PSEAT}`]: [{ status: 200, body: { status: "seated", table_id: "pk_bronze_1", seat: 2 } }],
    [`POST ${SEAT}`]: [seated],
    [`DELETE ${SEAT}`]: [{ status: 200, body: { status: "left" } }],
    ["GET /v1/playce/halls/casino/poker/levels"]: [{
      status: 200,
      body: [{ level: "bronze", stakes: [100, 250], tables_open: 1, tables_max: 4, seats_free: 0, queue: 2, estimated_wait_seconds: 40 }],
    }],
  });
  const c = client();
  const p = await c.requestSeat("poker", { level: "bronze", buyIn: 150, clientSeed: "abc" });
  check("requestSeat poker sends level, buy_in and client_seed",
    JSON.stringify(calls[0].body) === JSON.stringify({ level: "bronze", buy_in: 150, client_seed: "abc" }),
    JSON.stringify(calls[0].body));
  check("requestSeat returns the typed status", p.status === 200 && p.data.status === "seated" && p.data.table_id === "pk_bronze_1");

  await c.requestSeat("blackjack", { buyIn: 150, clientSeed: "x" });
  check("requestSeat blackjack never sends buy_in (the gateway 400s it)", JSON.stringify(calls[1].body) === "{}", JSON.stringify(calls[1].body));

  const l = await c.leaveQueue("blackjack");
  check("leaveQueue is a DELETE on the seat path", calls[2].method === "DELETE" && calls[2].path === SEAT && l.data.status === "left");

  const lv = await c.listLevels("poker");
  check("listLevels reads the public level rows", lv.status === 200 && lv.data[0].level === "bronze" && lv.data[0].stakes[1] === 250);
}

// ---- waitForSeat: seated immediately ----
{
  const calls = mockFetch({ [`POST ${SEAT}`]: [seated] });
  const clock = fakeClock();
  const updates: SeatQueueUpdate[] = [];
  const r = await client().waitForSeat("blackjack", { clock, onUpdate: (u) => updates.push(u) });
  check("seated immediately → resolves with the seat", r.status === "seated" && r.table_id === "bj_aurum_3" && r.seat === 1);
  check("seated immediately → one request, no sleeps, no updates",
    calls.length === 1 && clock.sleeps.length === 0 && updates.length === 0);
}

// ---- waitForSeat: queued → seated, onUpdate carries estimates, polls at poll_after ----
{
  const calls = mockFetch({ [`POST ${SEAT}`]: [queued(3, 75), queued(2, 45, { poll_after_seconds: 7 }), seated] });
  const clock = fakeClock();
  const updates: SeatQueueUpdate[] = [];
  const r = await client().waitForSeat("blackjack", { level: "low", clock, onUpdate: (u) => updates.push(u) });
  check("queued → seated resolves seated", r.status === "seated", JSON.stringify(r));
  check("every queued poll reaches onUpdate", updates.length === 2, `got ${updates.length}`);
  check("onUpdate carries position, estimate and basis",
    updates[0].position === 3 && updates[0].estimated_wait_seconds === 75 &&
      updates[0].estimate_basis === "2 residents finishing their hand" &&
      updates[1].position === 2 && updates[1].estimated_wait_seconds === 45);
  check("polls at poll_after_seconds", clock.sleeps[0] === 10_000 && clock.sleeps[1] === 7_000, JSON.stringify(clock.sleeps));
  check("no leaveQueue after a seat", !calls.some((c) => c.method === "DELETE"));
  check("default give-up is the first estimate + 2 min", updates[0].gives_up_at === 1_000_000 + 75_000 + 120_000);
}

// ---- poll cadence never outlives the place ----
{
  mockFetch({ [`POST ${SEAT}`]: [queued(1, 20, { poll_after_seconds: 90, expires_in_seconds: 60 }), seated] });
  const clock = fakeClock();
  await client().waitForSeat("blackjack", { clock });
  check("a poll_after longer than the expiry is clamped inside it", clock.sleeps[0] === 55_000, JSON.stringify(clock.sleeps));
}

// ---- abort → leaveQueue ----
{
  const calls = mockFetch({
    [`POST ${SEAT}`]: [queued(4, 300)],
    [`DELETE ${SEAT}`]: [{ status: 200, body: { status: "left" } }],
  });
  const ctrl = new AbortController();
  const clock = fakeClock();
  const r = await client().waitForSeat("blackjack", {
    clock,
    signal: ctrl.signal,
    onUpdate: (u) => { if (u.position === 4) ctrl.abort(); },
  });
  check("abort resolves aborted with the last queued status", r.status === "aborted" && (r as any).last?.position === 4, JSON.stringify(r));
  check("abort calls leaveQueue", calls.filter((c) => c.method === "DELETE" && c.path === SEAT).length === 1);
}

// ---- timeout → leaveQueue ----
{
  const calls = mockFetch({
    [`POST ${SEAT}`]: [queued(5, 600)],
    [`DELETE ${SEAT}`]: [{ status: 200, body: { status: "left" } }],
  });
  const clock = fakeClock();
  const r = await client().waitForSeat("blackjack", { clock, maxWaitMs: 25_000 });
  check("maxWaitMs → timeout", r.status === "timeout" && (r as any).waited_ms === 25_000, JSON.stringify(r));
  check("timeout calls leaveQueue", calls.some((c) => c.method === "DELETE" && c.path === SEAT));
  check("timeout polled at cadence then slept only the remainder",
    JSON.stringify(clock.sleeps) === JSON.stringify([10_000, 10_000, 5_000]), JSON.stringify(clock.sleeps));
}
{
  mockFetch({ [`POST ${SEAT}`]: [queued(9, 3600)], [`DELETE ${SEAT}`]: [{ status: 200, body: { status: "left" } }] });
  const clock = fakeClock();
  const r = await client().waitForSeat("blackjack", { clock });
  check("default give-up is capped at 15 minutes", r.status === "timeout" && (r as any).waited_ms === 15 * 60_000, JSON.stringify(r));
}

// ---- rejected ----
{
  const calls = mockFetch({
    [`POST ${PSEAT}`]: [{ status: 200, body: { status: "rejected", reason: "insufficient_balance: your balance does not cover the buy-in" } }],
  });
  const r = await client().waitForSeat("poker", { clock: fakeClock() });
  check("rejected resolves with the reason", r.status === "rejected" && /insufficient_balance/.test((r as any).reason));
  check("rejected does not retry", calls.length === 1);
}
{
  mockFetch({
    [`POST ${SEAT}`]: [{ status: 200, body: { status: "rejected", reason: "the floor is busy — try again" } }, seated],
  });
  const r = await client().waitForSeat("blackjack", { clock: fakeClock() });
  check("a busy-floor rejection is transient — retried", r.status === "seated");
}
{
  mockFetch({ [`POST ${SEAT}`]: [{ status: 400, body: { error: "casino floor: invalid seat request: unknown level \"vip\"" } }] });
  const r = await client().waitForSeat("blackjack", { level: "vip", clock: fakeClock() });
  check("400 unknown level → typed error, not a retry", r.status === "error" && (r as any).http_status === 400 && /unknown level/.test((r as any).message));
}

// ---- 404 fallback (gateway without the seat request) ----
{
  const calls = mockFetch({});
  const r = await client().waitForSeat("poker", { clock: fakeClock() });
  check("404 → unsupported so the caller uses the per-table join", r.status === "unsupported" && (r as any).http_status === 404);
  check("404 → no leaveQueue, no retries", calls.length === 1);
}

// ---- transient errors keep polling ----
{
  mockFetch({ [`POST ${SEAT}`]: [{ status: 503, body: { error: "hiccup" } }, queued(1, 5), seated] });
  const r = await client().waitForSeat("blackjack", { clock: fakeClock() });
  check("5xx is retried, not surfaced", r.status === "seated");
}

// ---- helpers ----
check("defaultSeatWaitMs: estimate + 2 min", defaultSeatWaitMs(75) === 195_000);
check("defaultSeatWaitMs: capped at 15 min", defaultSeatWaitMs(10_000) === 900_000);
check("alreadySeatedTable parses the table id",
  alreadySeatedTable("already seated at pk_bronze_1 (level bronze) — leave that table first") === "pk_bronze_1" &&
    alreadySeatedTable("insufficient_balance: nope") === null);
check("describeQueue reads like a host",
  describeQueue({ position: 3, level: "low", estimated_wait_seconds: 75, estimate_basis: "2 residents finishing their hand" }) ===
    "you're 3rd in line for low — about 75 seconds (2 residents finishing their hand)",
  describeQueue({ position: 3, level: "low", estimated_wait_seconds: 75, estimate_basis: "2 residents finishing their hand" }));
check("describeWait rounds sensibly",
  describeWait(0) === "any moment now" && describeWait(300) === "about 5 minutes" && describeWait(11) === "about 11 seconds");

if (failures > 0) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log("\nall checks passed");
