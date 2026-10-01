import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const route = readFileSync("app/api/agents/paper-trade/route.ts", "utf8");
const migration = readFileSync("supabase/migrations/20260806203000_prevent_paper_alpha_pyramiding.sql", "utf8");

describe("paper fill one-entry integrity", () => {
  it("only considers held-name adds when the fresh fill exceeds weighted cost", () => {
    expect(route).toContain("const existingPosition = openAlphaPositionsByMarket");
    expect(route).toContain("assessPaperTopUp({ fillPrice, weightedAverageCost: weightedCost");
    expect(route).toContain("geometryAssessment.reason");
    expect(route).toContain("frequencyAssessment.reason");
    expect(route).toContain("Math.min(8, mandateByMarket.get(market)?.max_open_positions ?? 8)");
    expect(route).toContain("const needsRotation = !isTopUp");
    expect(route).toContain('supabase.rpc(isTopUp ? "execute_paper_topup" : "execute_paper_fill"');
    expect(route).toContain('reason: "execute_paper_topup_rpc_missing"');
    expect(route).toContain("if (!rpcSucceeded && isTopUp)");
    expect(route).toContain("appliedStopLoss = topUpActiveStop ?? stopLoss");
    expect(route).toContain("appliedPriceTarget = topUpActiveTarget ?? priceTarget");
  });

  it("keeps direct inserts blocked and grants the narrow bypass only inside the validated fill RPC", () => {
    expect(migration).toContain("paper_trades_prevent_alpha_pyramid");
    expect(migration).toContain("message = 'existing_open_position'");
    expect(migration).toContain("paper_trades_buy_event_unique");
    expect(migration).toContain("paper_trades_buy_signal_unique");
    expect(migration).toContain("paper_order_events_buy_signal_unique");
    const topUpMigration = readFileSync("supabase/migrations/20261001150000_qualified_paper_topups.sql", "utf8");
    expect(topUpMigration).toContain("kairos.paper_topup_authorized");
    expect(topUpMigration).toContain("v_existing_id is not null");
    expect(topUpMigration).toContain("p_fill_price <= v_existing_avg");
    expect(topUpMigration).toContain("new.fill_price > position.avg_cost");
    expect(topUpMigration).toContain("top_up_session_window_missing");
    expect(topUpMigration).toContain("top_up_already_filled_this_session");
    expect(topUpMigration).toContain("executed_at >= p_day_start");
    expect(topUpMigration).toContain("set_config('kairos.paper_topup_authorized', 'off', true)");
    expect(topUpMigration).toContain("create or replace function public.execute_paper_topup(");
    expect(topUpMigration).toContain("revoke all on function public.execute_paper_topup");
  });
});
