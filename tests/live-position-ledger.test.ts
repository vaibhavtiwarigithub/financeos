import { describe, expect, it } from "vitest";
import { canonicalPositionSymbol, normalizeSnapshotHolding, reconstructAccountLivePositions } from "@/lib/trading/live-position-ledger";

const fallback = { stopLossPct: 7, targetPct: 20, maxHoldDays: 15, horizonDays: 10, mandateVersion: 3 };

describe("live position ledger", () => {
  it("excludes fills without exact active-account proposal lineage", () => {
    const positions = reconstructAccountLivePositions({
      activeAccount: "acct-a",
      fallbackPolicy: fallback,
      proposals: [
        { id: 1, account_number: "acct-a" },
        { id: 2, account_number: "acct-b" },
      ],
      orders: [
        { proposal_id: 1, symbol: "AAPL", side: "buy", filled_qty: 2, avg_fill_price: 100, created_at: "2026-07-01T00:00:00Z" },
        { proposal_id: 2, symbol: "AAPL", side: "buy", filled_qty: 9, avg_fill_price: 200, created_at: "2026-07-02T00:00:00Z" },
        { proposal_id: null, symbol: "MSFT", side: "buy", filled_qty: 5, avg_fill_price: 50, created_at: "2026-07-03T00:00:00Z" },
      ],
    });
    expect(positions).toHaveLength(1);
    expect(positions[0]).toMatchObject({ symbol: "AAPL", qty: 2, avgEntry: 100 });
  });

  it("consumes partial sells FIFO and removes their cost basis", () => {
    const proposals = [1, 2, 3].map(id => ({ id, account_number: "acct-a" }));
    const positions = reconstructAccountLivePositions({
      activeAccount: "acct-a",
      fallbackPolicy: fallback,
      proposals,
      orders: [
        { proposal_id: 1, symbol: "AAPL", side: "buy", filled_qty: 2, avg_fill_price: 100, created_at: "2026-07-01T00:00:00Z" },
        { proposal_id: 2, symbol: "AAPL", side: "buy", filled_qty: 3, avg_fill_price: 200, created_at: "2026-07-02T00:00:00Z" },
        { proposal_id: 3, symbol: "AAPL", side: "sell", filled_qty: 2, avg_fill_price: 150, created_at: "2026-07-03T00:00:00Z" },
      ],
    });
    expect(positions[0].qty).toBe(3);
    expect(positions[0].avgEntry).toBe(200);
  });

  it("uses only a broker-confirmed fractional partial fill", () => {
    const positions = reconstructAccountLivePositions({
      activeAccount: "acct-a",
      fallbackPolicy: fallback,
      proposals: [{ id: 1, account_number: "acct-a" }, { id: 2, account_number: "acct-a" }],
      orders: [
        { proposal_id: 1, symbol: "AAPL", side: "buy", filled_qty: 0.75, avg_fill_price: 100, created_at: "2026-07-01T00:00:00Z", status: "filled" },
        // The broker accepted a 0.5-share SELL but has filled only 0.25. The
        // ledger must retain 0.5, not falsely consume the requested 0.5.
        { proposal_id: 2, symbol: "AAPL", side: "sell", qty: 0.5, filled_qty: 0.25, avg_fill_price: 110, created_at: "2026-07-02T00:00:00Z", status: "partially_filled" },
      ],
    });
    expect(positions).toHaveLength(1);
    expect(positions[0].qty).toBeCloseTo(0.5, 8);
  });

  it("does not invent a fill when a partial order lacks confirmed quantity", () => {
    const positions = reconstructAccountLivePositions({
      activeAccount: "acct-a", fallbackPolicy: fallback,
      proposals: [{ id: 1, account_number: "acct-a" }, { id: 2, account_number: "acct-a" }],
      orders: [
        { proposal_id: 1, symbol: "AAPL", side: "buy", filled_qty: 0.75, avg_fill_price: 100, created_at: "2026-07-01T00:00:00Z", status: "filled" },
        { proposal_id: 2, symbol: "AAPL", side: "sell", qty: 0.5, created_at: "2026-07-02T00:00:00Z", status: "partially_filled" },
      ],
    });
    expect(positions[0].qty).toBeCloseTo(0.75, 8);
  });

  it("uses recorded per-fill policy and marks legacy fallback honestly", () => {
    const recorded = reconstructAccountLivePositions({
      activeAccount: "acct-a",
      fallbackPolicy: fallback,
      proposals: [{
        id: 1,
        account_number: "acct-a",
        policy_snapshot: { execution_trade_plan: { version: "v1", stop_loss_pct: 5, target_pct: 12, max_hold_days: 5, horizon_days: 5, mandate_version: 8, source: "ledger_percentile" } },
      }],
      orders: [{ proposal_id: 1, symbol: "AAPL", side: "buy", filled_qty: 1, avg_fill_price: 100, created_at: "2026-07-01T00:00:00Z" }],
    })[0];
    expect(recorded).toMatchObject({ stopPrice: 95, targetPrice: 112, policySource: "recorded" });
    expect(recorded).toMatchObject({ firstBuyAt: "2026-07-01T00:00:00.000Z", horizonDays: 5 });

    const legacy = reconstructAccountLivePositions({
      activeAccount: "acct-a",
      fallbackPolicy: fallback,
      proposals: [{ id: 1, account_number: "acct-a" }],
      orders: [{ proposal_id: 1, symbol: "AAPL", side: "buy", filled_qty: 1, avg_fill_price: 100, created_at: "2026-07-01T00:00:00Z" }],
    })[0];
    expect(legacy.policySource).toBe("legacy_mandate_fallback");
  });

  it("normalizes snapshot aliases and rejects zero quantities", () => {
    expect(normalizeSnapshotHolding({ symbol: "reliance.ns", quantity: "2", average_buy_price: "1450", last_price: 1500 }))
      .toEqual({ symbol: "RELIANCE.NS", qty: 2, avgPrice: 1450, currentPrice: 1500 });
    expect(normalizeSnapshotHolding({ symbol: "AAPL", qty: 0 })).toBeNull();
    expect(canonicalPositionSymbol("reliance.ns", "india")).toBe("RELIANCE");
  });
});
