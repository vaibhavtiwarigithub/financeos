import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const migration = readFileSync("supabase/migrations/20261030173804_strategy_template_shadow_flow.sql", "utf8");
const aclMigration = readFileSync("supabase/migrations/20261030173857_strategy_template_shadow_service_acl.sql", "utf8");
const collector = readFileSync("lib/strategy-replay/template-shadow-collector.ts", "utf8");
const route = readFileSync("app/api/strategies/template-shadows/route.ts", "utf8");

describe("bounded strategy discovery and shadow flow contract", () => {
  it("keeps candidate count bounded and registers every fixed variant in the trial ledger", () => {
    expect(migration).toContain(">= 3");
    expect(migration).toContain("public.register_trial(");
    expect(route).toContain("action === \"scan\"");
    expect(route).toContain("const MAX_BACKTEST_SYMBOLS = 10");
    expect(route).toContain("const MAX_BARS_PER_SYMBOL = 750");
  });

  it("requires a priced benchmark holdout but does not require positive returns", () => {
    expect(migration).toContain("(v_backtest->'holdout'->>'sessions')::integer,0) < 30");
    expect(migration).toContain("(v_backtest->'holdout'->>'benchmarkMissingSessions')::integer,1) <> 0");
    expect(migration).toContain("v_backtest->'holdout'->>'excessReturnPp' is null");
    expect(migration).not.toMatch(/excessReturnPp'\s*<\s*0/);
  });

  it("uses separate append-only decision and outcome evidence with explicit service grants", () => {
    for (const table of ["strategy_template_shadow_events", "strategy_template_shadow_decisions", "strategy_template_shadow_outcomes"]) {
      expect(migration).toContain(`public.${table}`);
    }
    expect(migration).toContain("before update or delete on public.strategy_template_shadow_events");
    expect(migration).toContain("before update or delete on public.strategy_template_shadow_decisions");
    expect(migration).toContain("before update or delete on public.strategy_template_shadow_outcomes");
    expect(migration).toContain("grant select, insert on public.strategy_template_shadow_decisions to service_role");
    expect(migration).toContain("grant select, insert on public.strategy_template_shadow_outcomes to service_role");
    expect(migration).toContain("revoke truncate");
    expect(aclMigration).toContain("revoke all on public.strategy_template_shadow_configs from service_role");
    expect(aclMigration).toContain("grant select, insert on public.strategy_template_shadow_decisions to service_role");
    expect(aclMigration).toContain("grant select, insert on public.strategy_template_shadow_outcomes to service_role");
  });

  it("collects only on natural research, preserves provenance, and never invokes the money path", () => {
    expect(collector).toContain("TEMPLATE_SHADOW_PRICE_PROVENANCE");
    expect(collector).toContain("decision_price_basis: basis");
    expect(collector).toContain("onConflict: \"config_id,symbol,signal_session\"");
    expect(collector).toContain("entryIndex + config.rule_spec.horizonSessions");
    expect(route).not.toMatch(/paper_positions|submitOrder|live_proposal|broker/);
  });
});
