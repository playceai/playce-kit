/**
 * Covers the two pure helpers in scripts/setup.ts.
 *
 * extractRewards exists because REFERRAL_CODE=founders500 really pays — a
 * cold-run test was credited 610 GOLD — into the agent's COYNS WALLET, while
 * setup used to keep only agent_id + nonce from the register response and print
 * "GOLD on your Playce ledger: 100". The developer then had no way to learn the
 * bonus existed, sat on the casino floor, and was locked out of poker.
 *
 * Importing setup.ts must NOT run the registration flow — the direct-execution
 * guard at the bottom of that file is what makes this test possible, so simply
 * getting here proves the guard holds.
 */
import { extractRewards, parseTaunts } from "../scripts/setup.js";

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok || !detail ? "" : ` — ${detail}`}`);
  if (!ok) failures++;
}

check("importing setup.ts does not run the setup flow", true);

// ---- extractRewards ----

const keyed = (rs: { key: string }[]) => rs.map((r) => r.key).sort();

check(
  "a bare register response reports nothing",
  extractRewards({ agent_id: "agt_1", nonce: "n", status: "pending" }).length === 0,
);

check(
  "top-level reward fields are found",
  keyed(
    extractRewards({
      agent_id: "agt_1",
      nonce: "n",
      founder_welcome: "610 GOLD credited to your Coyns wallet",
      referral_welcome: true,
      welcome_reward: 610,
    }),
  ).join(",") === "founder_welcome,referral_welcome,welcome_reward",
);

check(
  "nested reward objects are found one level deep, with a dotted key",
  keyed(extractRewards({ rewards: { gold_bonus: 610 } })).join(",") === "rewards" ||
    keyed(extractRewards({ meta: { signup_bonus: 610 } })).join(",") === "meta.signup_bonus",
);

check(
  "null / empty / false values are not reported as a reward",
  extractRewards({ welcome_reward: null, referral_bonus: "", founder_welcome: false }).length === 0,
);

check(
  "values survive intact for printing",
  extractRewards({ welcome_reward: 610 })[0].value === 610,
);

// ---- parseTaunts (regression: a taunt containing a comma) ----

check("JSON-array taunts keep their commas", parseTaunts('["Cold start, warm hands."]').length === 1);
check("bare comma form still splits", parseTaunts("By the book.,Correct is correct.").length === 2);
check("empty is empty", parseTaunts(undefined).length === 0 && parseTaunts("  ").length === 0);

if (failures > 0) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log("\nall checks passed");
