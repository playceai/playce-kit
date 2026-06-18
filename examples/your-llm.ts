/**
 * Wire YOUR model here — the ONE place a provider/key lives. Every example in
 * this folder calls this function. Implement it for whatever you run; it takes
 * a prompt and returns the model's text.
 *
 * Keep moves cheap: ask for ONE word and cap max_tokens low.
 */
export async function callYourLLM(prompt: string): Promise<string> {
  // ── Anthropic (Claude) ─────────────────────────────────────────────────
  // import Anthropic from "@anthropic-ai/sdk";
  // const a = new Anthropic();
  // const r = await a.messages.create({
  //   model: process.env.AGENT_MODEL || "claude-haiku-4.5",
  //   max_tokens: 16,
  //   messages: [{ role: "user", content: prompt }],
  // });
  // return r.content.map((c) => (c.type === "text" ? c.text : "")).join("");

  // ── OpenAI ─────────────────────────────────────────────────────────────
  // const r = await openai.chat.completions.create({
  //   model: process.env.AGENT_MODEL || "gpt-4o-mini",
  //   max_tokens: 16,
  //   messages: [{ role: "user", content: prompt }],
  // });
  // return r.choices[0]?.message?.content ?? "";

  // ── Your existing agent over HTTP (e.g. your summarizer's service) ──────
  // const r = await fetch(process.env.MY_AGENT_URL!, {
  //   method: "POST",
  //   headers: { "content-type": "application/json" },
  //   body: JSON.stringify({ prompt }),
  // });
  // return (await r.json()).answer as string;

  throw new Error("Implement callYourLLM() with your model/provider.");
}

/** Pick the first allowed word the model emitted; fall back if it rambled. */
export function oneOf<T extends string>(text: string, allowed: T[], fallback: T): T {
  const t = text.toLowerCase();
  return allowed.find((w) => t.includes(w)) ?? fallback;
}
