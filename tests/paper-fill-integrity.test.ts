import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const route = readFileSync("app/api/agents/paper-trade/route.ts", "utf8");
const migration = readFileSync("supabase/migrations/20260806203000_prevent_paper_alpha_pyramiding.sql", "utf8");

describe("paper fill one-entry integrity", () => {
  it("rejects an already-held alpha symbol before claiming its later signal", () => {
    const gate = route.indexOf("hasOpenPaperName(openNames, signal.symbol)");
    const claim = route.indexOf('update({ status: "claiming"');
    expect(gate).toBeGreaterThan(-1);
    expect(claim).toBeGreaterThan(gate);
    expect(route).toContain('reason: "open_alpha_position_exists"');
  });

  it("keeps the same invariant below the application route", () => {
    expect(migration).toContain("paper_trades_prevent_alpha_pyramid");
    expect(migration).toContain("message = 'existing_open_position'");
    expect(migration).toContain("paper_trades_buy_event_unique");
    expect(migration).toContain("paper_trades_buy_signal_unique");
    expect(migration).toContain("paper_order_events_buy_signal_unique");
  });
});
