/** Helpers for turning answers into a .env, and for sanity-checking .gitignore. */

/** Quote only when dotenv would otherwise mis-read the value. */
function encode(value) {
  const v = String(value ?? "");
  if (v === "") return "";
  if (/^[\w.\-/:@+]+$/.test(v)) return v;
  return `"${v.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/**
 * Fill values into the kit's `.env.example`, preserving its comments — those
 * comments are the kit's real documentation for each knob, and a scaffolder
 * that strips them makes the project harder to edit than a manual clone.
 * Keys the example doesn't have are appended.
 *
 * @param {string} example  contents of .env.example
 * @param {Record<string,string|undefined>} values
 */
export function renderEnv(example, values) {
  let out = example;
  const extra = [];
  for (const [key, raw] of Object.entries(values)) {
    if (raw === undefined || raw === null) continue;
    const line = `${key}=${encode(raw)}`;
    const re = new RegExp(`^${key}=.*$`, "m");
    if (re.test(out)) out = out.replace(re, () => line);
    else extra.push(line);
  }
  if (extra.length) out += `\n${extra.join("\n")}\n`;
  return out;
}

/** A handle is public and gets lowercased server-side; do it here so what we write is what they get. */
export function normalizeHandle(input) {
  return String(input ?? "")
    .trim()
    .replace(/^@+/, "")
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 32);
}

/**
 * The kit already gitignores `.env` and `secrets/`, but this scaffolder pulls
 * from `main` at run time — verify rather than assume, because the file we're
 * protecting holds private keys and GOLD.
 */
export function ensureIgnored(current) {
  const lines = current.split(/\r?\n/).map((l) => l.trim());
  const missing = [];
  if (!lines.includes(".env")) missing.push(".env");
  if (!lines.some((l) => l === "secrets/" || l === "secrets")) missing.push("secrets/");
  if (!missing.length) return { text: current, added: [] };
  const sep = current.endsWith("\n") ? "" : "\n";
  return {
    text: `${current}${sep}\n# Added by create-playce-agent — these hold your private keys.\n${missing.join("\n")}\n`,
    added: missing,
  };
}
