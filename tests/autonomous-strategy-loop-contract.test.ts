import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const learner = readFileSync("app/api/agents/learner/route.ts", "utf8");
const paperTrader = readFileSync("app/api/agents/paper-trade/route.ts", "utf8");
const migration = readFileSync("supabase/migrations/20261030205231_autonomous_rule_paper_selector.sql", "utf8");
const feature = readFileSync("features/strategy-portfolio-lab/FEATURE_ARCHITECTURE.md", "utf8");

describe("autonomous rule strategy lifecycle contract", () => {
  it("uses existing weekly Learner and natural research evidence producers", () => {
    expect(learner).toContain("evaluateAndPersistAutonomousRuleShadows(svc, LEARN_MARKET)");
    expect(learner).toContain("autonomouslyStartTemplateShadow(svc");
    expect(learner).toContain("recentAttempts");
    expect(learner).toContain("max_active_shadows");
    expect(feature).toContain("existing natural ResearchAgent");
  });

  it("persists market-isolated append-only evaluations and selection through a service-only RPC", () => {
    expect(migration).toContain("strategy_template_paper_evaluations");
    expect(migration).toContain("strategy_template_paper_selection");
    expect(migration).toContain("apply_autonomous_rule_evaluations");
    expect(migration).toContain("strategy_template_paper_evaluations_append_only");
    expect(migration).toContain("grant execute on function public.apply_autonomous_rule_evaluations(text,jsonb,uuid) to service_role");
  });

  it("requires the fixed evidence thresholds before selection", () => {
    expect(migration).toContain("pairedSessions");
    expect(migration).toContain("< 60");
    expect(migration).toContain("nonoverlapWindows");
    expect(migration).toContain("< 20");
    expect(migration).toContain("meanPairedExcessPct");
    expect(migration).toContain("maxDrawdownRulePct");
  });

  it("lets a selected rule only change paper ranking after deterministic eligibility", () => {
    expect(paperTrader).toContain("strategy_template_paper_selection");
    expect(paperTrader).toContain("auto_rule_paper_select_enabled");
    expect(paperTrader).toContain("strategy_template_shadow_decisions");
    expect(paperTrader).toContain("strategyQualifiedSymbols");
    expect(paperTrader).toContain("selectBestPaperSignals(");
    expect(feature).toContain("bypass the score threshold");
  });
});
