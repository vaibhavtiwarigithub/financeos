import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { RISK_PROFILES } from "@/lib/risk-profiles";

// Settings -> Trading is the single place the owner configures live trading.
// Three separate defects made controls there report success without saving.
//
// 1. Seven handlers did a bare `await fetch(...)` with no res.ok check and then
//    set an unconditional success toast. /api/settings/risk-profile validates
//    hard and 400s on out-of-range input, so a rejected save showed
//    "Risk profile saved!" while strategy_config was untouched.
//
// 2. The Position size % control allowed up to 30 while the route enforces
//    "position_size_pct must be 1-25" — a reproducible silent no-op.
//
// 3. The page kept its OWN copy of the risk-profile dials carrying only 5 of
//    the 9 fields, so selecting a profile never applied its kill-switch brakes,
//    sector cap or exit hysteresis. lib/risk-profiles.ts exists specifically to
//    prevent that duplication; its header records the same bug happening three
//    times before.

const page = readFileSync(join(process.cwd(), "app/dashboard/settings/page.tsx"), "utf8");
const route = readFileSync(join(process.cwd(), "app/api/settings/risk-profile/route.ts"), "utf8");

/** Numeric bound the route enforces, read from its own validation line. */
function routeBound(field: string): { min: number; max: number } {
  const re = new RegExp(`${field} !== undefined && \\(${field} < (-?[\\d.]+) \\|\\| ${field} > (-?[\\d.]+)\\)`);
  const m = route.match(re);
  if (!m) throw new Error(`No route bound found for ${field}`);
  return { min: Number(m[1]), max: Number(m[2]) };
}

describe("UI bounds match what the route will accept", () => {
  it("Position size % cannot be set above what the route allows", () => {
    const { min, max } = routeBound("position_size_pct");
    const control = page.match(/label: "Position size %"[^}]*\}/);
    expect(control, "Position size % control not found").not.toBeNull();
    expect(control![0]).toContain(`min: ${min}`);
    expect(control![0]).toContain(`max: ${max}`);
  });

  it("the route still bounds the four money dials (guards against silent removal)", () => {
    expect(routeBound("position_size_pct")).toEqual({ min: 1, max: 25 });
    expect(routeBound("stop_loss_pct")).toEqual({ min: 1, max: 30 });
    expect(routeBound("target_pct")).toEqual({ min: 1, max: 100 });
    expect(routeBound("score_threshold")).toEqual({ min: 0, max: 100 });
  });
});

describe("the page does not keep a rival copy of the risk-profile dials", () => {
  it("imports the canonical dials instead of re-declaring the numbers", () => {
    expect(page).toMatch(/from "@\/lib\/risk-profiles"/);
  });

  it("declares no hardcoded dial numbers in its profile chrome", () => {
    const chrome = page.slice(page.indexOf("const RISK_PROFILE_CHROME"), page.indexOf("type RiskProfileKey"));
    for (const field of ["score_threshold", "position_size_pct", "stop_loss_pct", "target_pct", "max_positions_per_sector"]) {
      expect(chrome, `${field} must come from lib/risk-profiles.ts, not this page`).not.toContain(field);
    }
  });
});

describe("saving a risk profile applies ALL nine dials, not just the four editable ones", () => {
  const save = page.slice(page.indexOf("async function saveRiskProfile"));
  const body = save.slice(0, save.indexOf("} finally"));

  // These five have no manual override control, so they must follow the profile.
  for (const field of [
    "max_positions_per_sector",
    "ks_daily_loss_pct",
    "ks_drawdown_pct",
    "ks_accuracy_pct",
    "exit_hysteresis",
  ]) {
    it(`sends ${field}`, () => {
      expect(body).toContain(field);
    });
  }

  it("sources them from the selected profile's canonical dials", () => {
    expect(body).toMatch(/RISK_PROFILES\[riskProfile\]/);
  });

  it("every profile actually differs on the brakes (otherwise this fix is inert)", () => {
    const brakes = Object.values(RISK_PROFILES).map(p => p.ks_drawdown_pct);
    expect(new Set(brakes).size).toBe(brakes.length);
  });
});

describe("no trading-settings handler reports success it did not get", () => {
  // Every mutating handler must consult the response before claiming success:
  // either through the checked helpers, or with its own explicit res.ok branch.
  const HANDLERS = [
    "saveBrokerRegistry", "saveTradingEnabled", "saveOrderCaps", "applyPosture",
    "cancelPosture", "saveTradingConfig", "saveRiskProfile", "saveTradingStyle",
  ];

  for (const name of HANDLERS) {
    it(`${name} checks the result before toasting success`, () => {
      const start = page.indexOf(`async function ${name}`);
      expect(start, `${name} not found`).toBeGreaterThan(-1);
      // Bound the slice at the next top-level function declaration.
      const rest = page.slice(start + 10);
      const end = rest.indexOf("\n  async function ");
      const body = end === -1 ? rest : rest.slice(0, end);

      const usesCheckedHelper = /patchRiskToast\(|patchRisk\(/.test(body);
      const checksOk = /res\.ok|!res\b/.test(body);
      expect(
        usesCheckedHelper || checksOk,
        `${name} calls fetch and toasts without checking the response. ` +
        `Route it through patchRiskToast() or branch on res.ok.`,
      ).toBe(true);

      // A bare fetch whose result is never bound is the exact old shape.
      expect(body, `${name} still has an unchecked \`await fetch(\``)
        .not.toMatch(/await fetch\(\s*"\/api\/settings\/risk-profile"[\s\S]{0,400}?\}\);\s*\n\s*setToast\(/);
    });
  }
});
