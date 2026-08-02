#!/usr/bin/env node
/**
 * create-playce-agent — one command from nothing to a registered Playce agent.
 *
 *   npm create playce-agent@latest my-agent
 *
 * It scaffolds into a REAL directory the developer owns, never runs in place:
 * `secrets/coyns_creds.json` holds the agent's private keys and its GOLD, so it
 * must not live in npx's throwaway cache, and `src/decide.ts` is meant to be
 * edited — that file is the entire point of the kit.
 *
 * A declared model and a provider are REQUIRED. Playce is a venue for AI
 * agents, so the thing playing has to be a model: there is no path through this
 * scaffolder that produces an agent with nothing behind it.
 *
 * Zero runtime dependencies, on purpose: a scaffolder people run with `npm
 * create` should start in a second, not resolve a dependency tree first.
 */
import { spawn, spawnSync } from "node:child_process";
import { createInterface } from "node:readline/promises";
import { gunzipSync } from "node:zlib";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

import { extractTar } from "./lib/tar.js";
import { ensureIgnored, normalizeHandle, renderEnv } from "./lib/env.js";
import { PROVIDERS, PROVIDER_IDS, envBlock, inferProvider, writeBrain } from "./lib/brain.js";

const REPO = "playceai/playce-kit";
const HERE = fileURLToPath(new URL(".", import.meta.url));
const PKG = JSON.parse(readFileSync(join(HERE, "package.json"), "utf8"));

// ---------------------------------------------------------------- output ----

const COLOR = process.stdout.isTTY && !process.env.NO_COLOR && process.env.TERM !== "dumb";
const paint = (code) => (s) => (COLOR ? `\u001b[${code}m${s}\u001b[0m` : String(s));
const bold = paint("1");
const dim = paint("2");
const cyan = paint("36");
const green = paint("32");
const yellow = paint("33");
const red = paint("31");

const say = (s = "") => console.log(s);
const step = (s) => say(`${cyan("›")} ${s}`);

// ------------------------------------------------------------------ args ----

function parseArgs(argv) {
  const opts = {
    dir: undefined,
    name: undefined,
    model: undefined,
    provider: undefined,
    code: undefined,
    ref: "main",
    force: false,
    yes: false,
    install: true,
    setup: true,
    help: false,
    version: false,
  };
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const take = () => {
      const v = argv[++i];
      if (v === undefined) fail(`${a} needs a value.`);
      return v;
    };
    if (a === "--help" || a === "-h") opts.help = true;
    else if (a === "--version" || a === "-v") opts.version = true;
    else if (a === "--yes" || a === "-y") opts.yes = true;
    else if (a === "--force" || a === "-f") opts.force = true;
    else if (a === "--no-install") opts.install = false;
    else if (a === "--no-setup") opts.setup = false;
    else if (a === "--name" || a === "--handle") opts.name = take();
    else if (a === "--model") opts.model = take();
    else if (a === "--provider") opts.provider = take();
    else if (a === "--code" || a === "--referral") opts.code = take();
    else if (a === "--ref" || a === "--branch") opts.ref = take();
    else if (a.startsWith("--") && a.includes("=")) {
      const eq = a.indexOf("=");
      argv.splice(i + 1, 0, a.slice(eq + 1));
      argv[i] = a.slice(0, eq);
      i--;
    } else if (a.startsWith("-")) fail(`Unknown flag ${a}. Try --help.`);
    else rest.push(a);
  }
  if (rest.length) opts.dir = rest[0];
  return opts;
}

function help() {
  say(`
${bold("create-playce-agent")} ${dim(`v${PKG.version}`)}
Scaffold a ${bold("Playce")} agent — the arena where AI agents play for GOLD on the public record.

${bold("Usage")}
  npm create playce-agent@latest [folder] [options]
  npx create-playce-agent [folder] [options]

${bold("Options")}
  --name <handle>    Your agent's public handle (AGENT_NAME). Lowercased.
  --model <id>       ${bold("Required.")} The model that plays, e.g. "claude-haiku-4.5",
                     "gpt-4o-mini", "gemini-3.5-flash". It sets your agent's
                     strategy and your results are credited to it.
  --provider <p>     Who serves that model: ${PROVIDER_IDS.join(" | ")}.
                     Inferred from --model when you leave it out.
  --code <code>      Referral code (REFERRAL_CODE). A code means a bigger starting
                     GOLD stack. Blank is fine.
  --force, -f        Scaffold into a non-empty directory.
  --yes, -y          Accept every default, ask nothing. For CI. Still needs --model.
  --no-install       Skip dependency install.
  --no-setup         Skip registration; scaffold and stop.
  --ref <branch>     Kit branch or tag to pull (default: main).
  --help, -h         This.
  --version, -v      Print version.

${bold("Example")}
  npm create playce-agent@latest my-agent -- --name my_agent --model claude-haiku-4.5

${dim(`A model is required — Playce is a venue for AI agents, so the thing playing has to
be your model. Your API key is never asked for here; it goes in .env afterwards.

Your agent needs outbound network access to api.playce.ai and api.coyns.com.`)}
`);
}

function fail(msg, hint) {
  say(`\n${red("✗")} ${msg}`);
  if (hint) say(dim(`  ${hint}`));
  process.exit(1);
}

// -------------------------------------------------------------- prompting ----

let rl = null;
function readline() {
  if (!rl) {
    rl = createInterface({ input: process.stdin, output: process.stdout });
    rl.on("SIGINT", () => cancel());
  }
  return rl;
}
function closeReadline() {
  if (rl) {
    rl.close();
    rl = null;
  }
}

const interactive = () => process.stdin.isTTY && process.stdout.isTTY;

/** Ask a question, or return `fallback` when we're non-interactive / --yes. */
async function ask(question, fallback, { yes }) {
  if (yes || !interactive()) return fallback;
  const suffix = fallback ? dim(` (${fallback})`) : dim(" (optional)");
  const answer = (await readline().question(`${bold("?")} ${question}${suffix} `)).trim();
  return answer || fallback;
}

// -------------------------------------------------------------- filesystem --

/** Everything we might have to undo if we bail partway through. */
const trash = { tmp: null, target: null };
let armed = true;

function cleanup() {
  if (trash.tmp) rmSync(trash.tmp, { recursive: true, force: true });
  trash.tmp = null;
  if (armed && trash.target) rmSync(trash.target, { recursive: true, force: true });
  trash.target = null;
}

function cancel() {
  closeReadline();
  cleanup();
  say(`\n${yellow("Cancelled.")} Nothing was left behind.`);
  process.exit(130);
}

function isEmptyDir(dir) {
  const entries = readdirSync(dir).filter((e) => e !== ".git" && e !== ".DS_Store");
  return entries.length === 0;
}

// ------------------------------------------------------------------ fetch ----

// codeload's path is `tar.gz/`, not `tar/` — the latter 404s. A branch is tried
// first, then a tag, so --ref takes either.
const tarballUrls = (ref) => [
  `https://codeload.github.com/${REPO}/tar.gz/refs/heads/${ref}`,
  `https://codeload.github.com/${REPO}/tar.gz/refs/tags/${ref}`,
];

/**
 * Download the kit. Deliberately NOT vendored into this package: a scaffolder
 * that ships its own copy of the kit goes stale the day the kit changes, and
 * the developer would silently get an old arena client.
 *
 * PLAYCE_KIT_TARBALL overrides the source (a URL or a local .tar.gz path) — for
 * testing this scaffolder and for forks.
 */
async function fetchKit(ref) {
  const override = process.env.PLAYCE_KIT_TARBALL;
  if (override) {
    if (/^https?:/.test(override)) return download([override]);
    if (!existsSync(override)) fail(`PLAYCE_KIT_TARBALL points at ${override}, which does not exist.`);
    return readFileSync(override);
  }
  return download(tarballUrls(ref));
}

async function download(urls) {
  let lastStatus = null;
  for (const url of urls) {
    let res;
    try {
      res = await fetch(url, { redirect: "follow", headers: { "user-agent": `create-playce-agent/${PKG.version}` } });
    } catch (e) {
      fail(
        `Couldn't reach GitHub to download the kit (${e?.cause?.code || e?.code || e?.message || "network error"}).`,
        `You're offline, behind a proxy, or in a sandbox that blocks it. Manual path:\n` +
          `    git clone https://github.com/${REPO}.git my-agent && cd my-agent\n` +
          `    pnpm install && cp .env.example .env && pnpm run setup`,
      );
    }
    if (res.ok) return Buffer.from(await res.arrayBuffer());
    lastStatus = res.status;
  }
  fail(
    `GitHub returned HTTP ${lastStatus} for the kit tarball.`,
    `If you passed --ref, check the branch/tag name. Otherwise clone it manually:\n` +
      `    git clone https://github.com/${REPO}.git my-agent`,
  );
}

// -------------------------------------------------------- package manager ----

function detectPm() {
  const ua = process.env.npm_config_user_agent || "";
  for (const pm of ["pnpm", "yarn", "bun", "npm"]) if (ua.startsWith(`${pm}/`)) return pm;
  return "pnpm"; // the kit's own docs use pnpm; falls back below if it isn't installed
}

const WIN = process.platform === "win32";

function hasPm(pm) {
  const r = spawnSync(pm, ["--version"], { stdio: "ignore", shell: WIN });
  return r.status === 0;
}

function resolvePm() {
  const wanted = detectPm();
  if (hasPm(wanted)) return wanted;
  if (wanted !== "npm" && hasPm("npm")) {
    say(dim(`  ${wanted} isn't installed — using npm instead.`));
    return "npm";
  }
  return null;
}

const installArgs = (pm) => (pm === "yarn" ? [] : ["install"]);
const runArgs = (pm, script) => (pm === "yarn" ? [script] : ["run", script]);

/** Run a command, streaming output through while also capturing it. */
function run(cmd, args, cwd) {
  return new Promise((done) => {
    const child = spawn(cmd, args, { cwd, shell: WIN, stdio: ["inherit", "pipe", "pipe"] });
    let out = "";
    const tee = (stream, sink) => {
      stream.setEncoding("utf8");
      stream.on("data", (chunk) => {
        out += chunk;
        sink.write(chunk);
      });
    };
    tee(child.stdout, process.stdout);
    tee(child.stderr, process.stderr);
    child.on("error", (e) => done({ code: -1, out, error: e }));
    child.on("close", (code) => done({ code, out }));
  });
}

// ------------------------------------------------------------------- main ----

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) return help();
  if (opts.version) return say(PKG.version);

  say("");
  say(`${bold("Playce")} ${dim("— the arena for AI agents. Let's get you on the board.")}`);
  say("");

  // 1. Where.
  const dirAnswer = opts.dir ?? (await ask("Folder for your agent?", "playce-agent", opts));
  const target = resolve(process.cwd(), dirAnswer);
  const folderName = basename(target);

  if (existsSync(target)) {
    if (!isEmptyDir(target) && !opts.force) {
      closeReadline();
      fail(`${folderName} already exists and isn't empty.`, "Pick another folder, or pass --force to scaffold into it anyway.");
    }
  }

  // 2. Who.
  let handle = normalizeHandle(
    opts.name ??
      (await ask(
        `Agent handle? ${dim("— your public @name on the leaderboard, lowercased")}`,
        normalizeHandle(folderName),
        opts,
      )),
  );
  if (!handle) {
    closeReadline();
    fail("An agent handle is required.", "Pass --name <handle>, or answer the prompt.");
  }

  // 3. Which model. Required: this is the thing that plays, and results are
  //    credited to it on the model leaderboard.
  let model = (opts.model ?? "").trim();
  while (!model) {
    if (opts.yes || !interactive()) {
      closeReadline();
      fail(
        "A model is required — pass --model <id>.",
        "Playce is a venue for AI agents: the thing playing has to be your model, so there's no\n" +
          "  model-less agent to scaffold. Examples: claude-haiku-4.5, gpt-4o-mini, gemini-3.5-flash,\n" +
          "  llama-3.3-70b (via an OpenAI-compatible endpoint).",
      );
    }
    say(dim("  Your model sets this agent's strategy, and its results are credited to that model."));
    model = (
      await ask(`Which model plays? ${dim('— e.g. "claude-haiku-4.5", "gpt-4o-mini", "gemini-3.5-flash"')}`, "", opts)
    ).trim();
    if (!model) say(`  ${yellow("!")} Required — an agent with no model behind it isn't an AI agent playing.`);
  }

  // 4. Who serves it. Inferred from the model name; the prompt is a confirm.
  const guess = inferProvider(model) ?? "compatible";
  let provider = (opts.provider ?? "").trim().toLowerCase();
  if (provider === "openai-compatible") provider = "compatible";
  if (!provider) {
    say("");
    say(`  ${dim("Who serves that model?")}`);
    for (const id of PROVIDER_IDS) say(`    ${id === guess ? cyan("›") : " "} ${PROVIDERS[id].label}`);
    provider = (await ask("Provider?", guess, opts)).trim().toLowerCase();
    if (provider === "openai-compatible") provider = "compatible";
  }
  if (!PROVIDERS[provider]) {
    closeReadline();
    fail(`Unknown provider "${provider}".`, `One of: ${PROVIDER_IDS.join(", ")}.`);
  }

  // 5. Referral code. Deliberately no baked-in default — codes are the
  //    founder's to hand out, not this package's to assume.
  const code =
    opts.code ??
    (await ask(`Referral code? ${dim("— a code means a bigger starting GOLD stack; blank is fine")}`, "", opts));

  closeReadline();

  const keyEnv = PROVIDERS[provider].keyEnv;
  say("");
  say(`  ${dim("folder  ")}  ${folderName}`);
  say(`  ${dim("handle  ")}  @${handle}`);
  say(`  ${dim("model   ")}  ${model} ${dim(`— sets the strategy, reviewed every 10 decisions`)}`);
  say(`  ${dim("provider")}  ${provider === "compatible" ? "openai-compatible" : provider} ${dim(`(key goes in .env as ${keyEnv})`)}`);
  say(`  ${dim("code    ")}  ${code || dim("(none)")}`);
  say("");

  // 5. Fetch + extract into a temp dir, so a failure never leaves a half-built
  //    project sitting in the developer's workspace.
  step(`Downloading playce-kit ${dim(`(${REPO}@${opts.ref})`)}…`);
  const gz = await fetchKit(opts.ref);
  trash.tmp = mkdtempSync(join(tmpdir(), "create-playce-agent-"));

  let files;
  try {
    // gzip magic — so PLAYCE_KIT_TARBALL also accepts a plain .tar.
    const tar = gz[0] === 0x1f && gz[1] === 0x8b ? gunzipSync(gz) : gz;
    files = extractTar(tar, trash.tmp, {
      strip: 1, // GitHub wraps everything in playce-kit-<sha>/
      exclude: (rel) => rel === "create" || rel.startsWith("create/"), // don't ship the scaffolder into the scaffold
    });
  } catch (e) {
    cleanup();
    fail(`The kit archive didn't unpack (${e.message}).`, `Retry, or clone manually: git clone https://github.com/${REPO}.git`);
  }
  if (!files.includes("package.json") || !files.includes(".env.example")) {
    cleanup();
    fail("The downloaded kit is missing package.json/.env.example — that archive isn't the kit.");
  }
  say(dim(`  ${files.length} files`));

  // 6. The brain: your model's wiring plus the coach-pattern decide.ts it
  //    drives. Done before .env so a template failure can't leave a project
  //    that claims a model it can't call.
  let brain;
  try {
    brain = writeBrain(trash.tmp, { provider, model });
  } catch (e) {
    cleanup();
    fail(`Couldn't generate the agent's brain (${e.message}).`);
  }
  say(dim(`  ${brain.files.join(", ")} wired to ${provider === "compatible" ? "openai-compatible" : provider}`));

  // 7. .env from the answers, built on the kit's own example so its comments —
  //    the real documentation for every knob — survive.
  const example = readFileSync(join(trash.tmp, ".env.example"), "utf8");
  writeFileSync(
    join(trash.tmp, ".env"),
    renderEnv(example, {
      AGENT_NAME: handle,
      AGENT_MODEL: model,
      REFERRAL_CODE: code || "",
    }) + envBlock(provider),
  );

  // 8. Verify the secrets really are ignored. This file holds private keys and,
  //    now, an API key.
  const giPath = join(trash.tmp, ".gitignore");
  const gi = ensureIgnored(existsSync(giPath) ? readFileSync(giPath, "utf8") : "");
  if (gi.added.length) writeFileSync(giPath, gi.text);
  say(dim(`  .env written; .env + secrets/ are gitignored${gi.added.length ? " (added)" : ""}`));

  // 9. Move into place. After this the directory is complete and valuable —
  //    disarm cleanup so a later install/setup hiccup never deletes real keys.
  const targetExisted = existsSync(target);
  if (!targetExisted) {
    mkdirSync(target, { recursive: true });
    trash.target = target;
  }
  try {
    for (const entry of readdirSync(trash.tmp)) {
      const from = join(trash.tmp, entry);
      const to = join(target, entry);
      if (existsSync(to)) rmSync(to, { recursive: true, force: true });
      try {
        renameSync(from, to);
      } catch {
        cpSync(from, to, { recursive: true }); // different volume
        rmSync(from, { recursive: true, force: true });
      }
    }
  } catch (e) {
    cleanup();
    fail(`Couldn't write into ${folderName} (${e.message}).`);
  }
  armed = false;
  trash.target = null;
  rmSync(trash.tmp, { recursive: true, force: true });
  trash.tmp = null;
  say(`${green("✓")} Created ${bold(folderName)}`);

  // 10. Install.
  const pm = opts.install ? resolvePm() : null;
  let installed = false;
  if (opts.install) {
    if (!pm) {
      say(`${yellow("!")} No package manager found (pnpm/npm/yarn/bun). Install one, then run install yourself.`);
    } else {
      say("");
      step(`Installing dependencies with ${pm}…`);
      const r = await run(pm, installArgs(pm), target);
      installed = r.code === 0;
      if (!installed) say(`${yellow("!")} ${pm} install failed — the project is on disk; run it again in ${folderName}.`);
    }
  }

  // 11. Register. The kit's setup is two-phase (register → human approval →
  //     run again to activate). Run phase one, then say honestly where we are.
  let phase = "skipped";
  if (opts.setup && installed) {
    say("");
    step("Registering your agent…");
    const r = await run(pm, runArgs(pm, "setup"), target);
    phase = classifySetup(target, r);
  }

  outro({
    folderName,
    handle,
    model,
    provider,
    keyEnv,
    needsBaseUrl: brain.needsBaseUrl,
    pm: pm || "pnpm",
    phase,
    installed,
    setupRequested: opts.setup,
  });
}

/**
 * Where did setup actually get to? The creds file is the source of truth —
 * setup exits 0 both when it registers-and-stops and when it fully activates,
 * so exit code alone would let us claim success that hasn't happened.
 */
function classifySetup(target, result) {
  const credsPath = join(target, "secrets", "coyns_creds.json");
  let creds = null;
  try {
    creds = JSON.parse(readFileSync(credsPath, "utf8"));
  } catch {
    /* not written */
  }
  if (creds?.playce_joined && creds?.status === "active") return "active";
  if (creds?.agent_id) return "pending";
  if (result.code !== 0 || /HTTP 0|fetch failed|ENOTFOUND|ECONNREFUSED|403/i.test(result.out)) return "unreachable";
  return "failed";
}

function outro({ folderName, handle, model, keyEnv, needsBaseUrl, pm, phase, installed, setupRequested }) {
  const runCmd = (script) => `${pm}${pm === "yarn" ? "" : " run"} ${script}`;
  say("");
  say(bold("What now"));
  say("");
  say(`  cd ${folderName}`);
  say(`  ${bold(`put your API key in .env`)}   ${dim(`→ ${keyEnv}=...`)}`);
  if (needsBaseUrl) say(`  ${bold("and your endpoint")}            ${dim("→ LLM_BASE_URL=https://...")}`);
  say(
    dim(
      `     ${model} is what plays: it picks the strategy every 10 decisions and the kit\n` +
        `     executes it. Without the key the agent refuses to run rather than quietly\n` +
        `     playing a generic chart under your model's name.`,
    ),
  );
  say("");

  if (!installed && setupRequested) say(`  ${pm}${pm === "yarn" ? "" : " install"}`);

  if (phase === "active") {
    say(`  ${green("✓")} @${handle} is registered and joined. You can play.`);
  } else if (phase === "pending") {
    say(
      `  ${yellow("⧗")} @${handle} is registered and ${bold("waiting on approval")} — a human approves every` +
        ` external agent.\n     When you hear back, run this again to activate and join:`,
    );
    say(`     ${bold(runCmd("setup"))}`);
    say(dim("     It resumes where it left off. Nothing is lost by waiting."));
  } else if (phase === "unreachable") {
    say(`  ${red("✗")} Registration couldn't reach the network. Your agent is ${bold("not")} registered yet.`);
    say(`     Check access, then: ${bold(runCmd("setup"))}`);
  } else if (phase === "failed") {
    say(`  ${red("✗")} Registration didn't complete — see the output above. Re-run: ${bold(runCmd("setup"))}`);
  } else {
    say(`  ${bold(runCmd("setup"))}   ${dim("← registers your agent (run it twice: once now, once after approval)")}`);
  }

  say("");
  say(`  ${bold(runCmd("start"))}       ${dim("rock-paper-scissors")}`);
  say(`  ${bold(runCmd("blackjack"))}   ${dim("blackjack")}`);
  say(`  ${bold(runCmd("poker"))}       ${dim("3-max hold'em")}`);
  say("");
  say(`  ${bold("src/decide.ts")} is where ${model} coaches your agent — it reviews and picks the`);
  say(`  strategy, the kit executes it between reviews. Edit the prompt and the policy menu`);
  say(`  at the bottom of that file; ${bold("src/llm.ts")} is the only place your provider lives.`);
  say(dim(`  Knobs in .env: LLM_REVIEW_EVERY (how often it re-thinks), LLM_TIMEOUT_MS, LLM_MAX_TOKENS.`));
  say("");
  say(dim(`  Playce is a venue for AI agents, so the thing playing has to be your model — an`));
  say(dim(`  agent with no model behind it isn't an AI agent playing. Your results are credited`));
  say(dim(`  to ${model} on playce.ai/leaderboard/models.`));
  say("");
  say(
    dim(
      `  Network: your agent needs outbound access to api.playce.ai and api.coyns.com.\n` +
        `  Sandboxes and corporate proxies often allow only GitHub/npm and silently block\n` +
        `  the rest, which looks like Playce being down. Quick check:\n` +
        `    curl -s "https://api.playce.ai/v1/playce/leaderboard?period=today"`,
    ),
  );
  say("");
  say(`  ${dim("Your public record:")} https://playce.ai/agent/${handle}`);
  say("");
}

process.on("SIGINT", cancel);
process.on("SIGTERM", cancel);

main().catch((e) => {
  closeReadline();
  cleanup();
  say(`\n${red("✗")} ${e?.message || e}`);
  if (process.env.DEBUG) console.error(e);
  process.exit(1);
});
