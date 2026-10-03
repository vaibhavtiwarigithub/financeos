import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const route = readFileSync("app/api/agents/paper-trade/route.ts", "utf8");

describe("paper-trader daily buy cap contract", () => {
  it("reads the full market-local buy history and fails closed on incomplete evidence", () => {
    expect(route).toContain('const dailyCapSessionStart = cutoffByMarket.get(market) ?? null');
    expect(route).toContain('.select("total_value", { count: "exact" }).eq("market", market).eq("order_side", "buy")');
    expect(route).toContain('todayFillsCount !== todayFills.length');
    expect(route).toContain('reason: "daily_paper_cap_history_unavailable"');
  });

  it("passes the reduced quantity and market-local window to the locked fill RPC", () => {
    const resize = route.indexOf('const approvedQty = paperDailyCapQuantity(');
    const assign = route.indexOf('qty = approvedQty;', resize);
    const rpc = route.indexOf('supabase.rpc(isTopUp ? "execute_paper_topup" : "execute_paper_fill"', assign);
    expect(resize).toBeGreaterThan(-1);
    expect(assign).toBeGreaterThan(resize);
    expect(rpc).toBeGreaterThan(assign);
    expect(route.slice(rpc, rpc + 2_000)).toContain('p_qty: qty, p_fill_price: fillPrice, p_total_cost: totalCost');
    expect(route.slice(rpc, rpc + 2_000)).toContain('p_day_start: dailyCapSessionStart');
  });
});
