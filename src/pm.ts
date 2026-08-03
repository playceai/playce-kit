/**
 * Which package manager is actually running this script.
 *
 * The kit's own messages used to hardcode `pnpm`, but a project scaffolded by
 * `npm create playce-agent` installs with npm — so setup would finish by telling
 * the developer to run `pnpm run setup` on the same screen where the scaffolder
 * had just said `npm run setup`. Two different commands for one step reads as a
 * bug in the tool.
 *
 * Package managers announce themselves in npm_config_user_agent (e.g.
 * "pnpm/8.15.9 npm/? node/v22.11.0 win32 x64"), which every one of them sets
 * when running a script. Unknown or absent → "npm", the safe default: it is
 * what ships with Node, so the instruction is never unrunnable.
 */
export function pm(): "npm" | "pnpm" | "yarn" | "bun" {
  const name = (process.env.npm_config_user_agent ?? "").split("/")[0];
  return name === "pnpm" || name === "yarn" || name === "bun" ? name : "npm";
}

/**
 * A runnable command for one of the kit's package.json scripts.
 *
 * Always emits the explicit `run` form. `pnpm setup` is NOT the same as
 * `pnpm run setup` — pnpm reserves `setup` for its own installer, so the bare
 * form silently does something else entirely (this bit a real developer during
 * a cold run). `<pm> run <script>` is correct for npm, pnpm, yarn and bun alike.
 */
export function cmd(script: string): string {
  return `${pm()} run ${script}`;
}
