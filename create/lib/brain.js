/**
 * Generates the agent's brain: the provider wiring (`src/llm.ts`) and the
 * coach-pattern `src/decide.ts` that lets the developer's declared model set
 * the strategy the kit executes.
 *
 * The templates are real files in create/templates/ rather than strings in
 * here, so the TypeScript that ships to developers can be read and reviewed as
 * TypeScript.
 */
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const TEMPLATES = fileURLToPath(new URL("../templates/", import.meta.url));
const read = (name) => readFileSync(join(TEMPLATES, name), "utf8");

/** Everything provider-specific lives here. */
export const PROVIDERS = {
  anthropic: {
    id: "anthropic",
    label: "anthropic  (Claude)",
    keyEnv: "ANTHROPIC_API_KEY",
    defaultModel: "claude-haiku-4.5",
    call: "call.anthropic.ts",
    keyHint: "console.anthropic.com → API keys",
  },
  openai: {
    id: "openai",
    label: "openai     (GPT)",
    keyEnv: "OPENAI_API_KEY",
    defaultModel: "gpt-4o-mini",
    call: "call.openai.ts",
    keyHint: "platform.openai.com → API keys",
  },
  google: {
    id: "google",
    label: "google     (Gemini)",
    keyEnv: "GEMINI_API_KEY",
    defaultModel: "gemini-3.5-flash",
    call: "call.google.ts",
    keyHint: "aistudio.google.com → API keys",
  },
  compatible: {
    id: "compatible",
    label: "openai-compatible  (OpenRouter, Groq, vLLM, Ollama, …)",
    keyEnv: "LLM_API_KEY",
    defaultModel: "",
    call: "call.compatible.ts",
    keyHint: "your provider's dashboard — also set LLM_BASE_URL",
    needsBaseUrl: true,
  },
};

export const PROVIDER_IDS = Object.keys(PROVIDERS);

/**
 * Guess the provider from the declared model, so the developer usually just
 * presses enter. Falls back to the OpenAI-compatible path, which is what
 * OpenRouter / Groq / vLLM / Ollama / llama.cpp all speak.
 */
export function inferProvider(model) {
  const m = String(model ?? "").toLowerCase();
  if (!m) return null;
  if (/claude|anthropic|sonnet|haiku|opus/.test(m)) return "anthropic";
  if (/^gpt|[/-]gpt|^o[134]\b|openai/.test(m)) return "openai";
  if (/gemini|google|gemma/.test(m)) return "google";
  return "compatible";
}

const TEST_NOTE = `/*
 * Re-pointed by create-playce-agent: these checks assert the RULES-BASED
 * default (source: "strategy"), which now lives in src/baseline.ts. Your
 * src/decide.ts is the coach — it executes a plan your model chose, so its
 * moves report source: "llm", and it refuses to run without an API key.
 */
`;

const BASELINE_NOTE = `/*
 * NOTE (create-playce-agent): this is the kit's ORIGINAL src/decide.ts, kept
 * here unmodified under a new name. It is not what plays — src/decide.ts is,
 * and it runs the strategy your model chose. This file stays for two reasons:
 *
 *   1. it defines the types the run loop imports (GameState, Decision, …), and
 *      src/decide.ts re-exports them from here, so they never drift;
 *   2. it is the reference for how a decision is shaped.
 */
`;

const COMPATIBLE_ACCESSOR = `
/**
 * Your OpenAI-compatible endpoint, INCLUDING the version path — e.g.
 * https://openrouter.ai/api/v1, https://api.groq.com/openai/v1, or
 * http://localhost:11434/v1 for Ollama.
 */
export function baseUrl(): string {
  return (process.env.LLM_BASE_URL ?? "").trim().replace(/\\/+$/, "");
}
`;

/**
 * Write the brain into an already-extracted kit.
 *
 * @param {string} root      the scaffolded project directory
 * @param {object} answers   { provider, model }
 * @returns {{ keyEnv: string, files: string[], needsBaseUrl: boolean }}
 */
export function writeBrain(root, { provider, model }) {
  const p = PROVIDERS[provider];
  if (!p) throw new Error(`unknown provider ${provider}`);

  const src = join(root, "src");

  // 1. The kit's decide.ts becomes baseline.ts — unmodified, apart from a note
  //    saying why it's there.
  const original = readFileSync(join(src, "decide.ts"), "utf8");
  renameSync(join(src, "decide.ts"), join(src, "baseline.ts"));
  writeFileSync(join(src, "baseline.ts"), BASELINE_NOTE + original);

  // 2. The provider wiring.
  const llm = read("llm.ts")
    .replace(/__PROVIDER__/g, provider === "compatible" ? "openai-compatible" : provider)
    .replace(/__KEY_ENV__/g, p.keyEnv)
    .replace(/__DEFAULT_MODEL__/g, model || p.defaultModel)
    .replace("__EXTRA_ACCESSORS__", p.needsBaseUrl ? COMPATIBLE_ACCESSOR : "")
    .replace("__ENABLED_EXTRA__", p.needsBaseUrl ? " && baseUrl()" : "")
    .replace(
      "__EXTRA_FIX__",
      p.needsBaseUrl ? "\n      `     ...and the endpoint:    LLM_BASE_URL=https://...`," : "",
    )
    .replace("__CALL_BODY__", read(p.call).replace(/\n$/, ""));
  writeFileSync(join(src, "llm.ts"), llm);

  // 3. The coach.
  writeFileSync(join(src, "decide.ts"), read("decide.ts"));

  // 4. Re-point the kit's bundled decide test at the baseline.
  //    That suite asserts source === "strategy", which is true of the kit's
  //    rules-based default and deliberately NOT true of the coach — every coach
  //    move executes a plan the developer's model chose, so it reports
  //    source: "llm". Worse, importing the coach with no API key exits 1 by
  //    design, so `pnpm test` would die on import. Left alone, a freshly
  //    scaffolded project greets its owner with a red test suite, which reads as
  //    "this kit is broken" rather than "this assertion moved". The baseline
  //    still exists and still behaves exactly as the test expects, so point the
  //    test there and it stays honest AND green.
  const testFile = join(root, "test", "decide.test.ts");
  if (existsSync(testFile)) {
    const t = readFileSync(testFile, "utf8")
      .replace(/(["'])(\.\.\/src\/)decide\.js\1/g, "$1$2baseline.js$1")
      .replace(/\bdefault is labeled source: strategy\b/g, "baseline is labeled source: strategy");
    writeFileSync(testFile, TEST_NOTE + t);
  }

  return { keyEnv: p.keyEnv, needsBaseUrl: Boolean(p.needsBaseUrl), files: ["src/llm.ts", "src/decide.ts", "src/baseline.ts"] };
}

/** The block appended to .env: a key placeholder and the coach's knobs. */
export function envBlock(provider) {
  const p = PROVIDERS[provider];
  const lines = [
    ``,
    `# ---------------------------------------------------------------------------`,
    `# Your model's API key. src/decide.ts asks ${p.id === "compatible" ? "your endpoint" : p.id} for a strategy every`,
    `# LLM_REVIEW_EVERY decisions; the kit executes that strategy in between.`,
    `#`,
    `# Paste the key here — never on the command line, where it lands in shell`,
    `# history. This file is gitignored. Without it the agent refuses to run.`,
    `# Get one: ${p.keyHint}`,
    `${p.keyEnv}=`,
  ];
  if (p.needsBaseUrl) {
    lines.push(
      ``,
      `# Your OpenAI-compatible endpoint, including the version path, e.g.`,
      `# https://openrouter.ai/api/v1  |  https://api.groq.com/openai/v1  |  http://localhost:11434/v1`,
      `LLM_BASE_URL=`,
    );
  }
  lines.push(
    ``,
    `# How many decisions run on one plan before your model reviews it again.`,
    `# Higher = fewer tokens, slower to adapt. Default 10.`,
    `#LLM_REVIEW_EVERY=10`,
    ``,
    `# Budget for one coaching call, ms. Must land inside the decision clock`,
    `# (poker 60s, blackjack ~15s). Default 8000.`,
    `#LLM_TIMEOUT_MS=8000`,
    ``,
    `# Output token cap for a plan. Raise it for thinking/reasoning models —`,
    `# they spend this budget before emitting any text. Default 512.`,
    `#LLM_MAX_TOKENS=512`,
    ``,
  );
  return lines.join("\n");
}
