import { describe, expect, it } from "vitest";
import { runAtrForwardCollection, type AtrForwardDeps } from "@/lib/shadows/atr-forward-run";
import { buildSeedSnapshotInput } from "@/lib/shadows/atr-forward-collector";
import { buildAtrReplaySeed } from "@/lib/shadows/atr-replay-seed";
import { buildShadowBookSnapshot, type ShadowBookSnapshotRow } from "@/lib/shadows/shadow-book-ledger";
import { expectedMarketSessionsBetween } from "@/lib/trading/market-calendar";
import type { YahooRawReplaySeries } from "@/lib/data/yahoo-candles";

const NOW = new Date("2026-09-29T23:00:00Z");

function series(candles: Array<[string, number, number, number, number]>): YahooRawReplaySeries {
  return {
    source: "yahoo_chart_v8", priceBasis: "raw_ohlc", actionsRequested: true, corporateActions: [],
    candles: candles.map(([date, open, high, low, close]) => ({ date, open, high, low, close, volume: 1000 })),
  };
}

const coverage = (symbol: string) => (["split", "dividend"] as const).map((action_type) => ({
  symbol, action_type, status: "complete", checked_at: "2026-09-27T00:00:00Z", provider_fetched_at: "2026-09-27T00:00:00Z", records_count: 0,
}));

function seedRow(): ShadowBookSnapshotRow {
  const seed = buildAtrReplaySeed({
    market: "us", session: "2026-09-25", cashBalance: 500, reportedNav: 1500,
    positions: [{ symbol: "ABC", market: "us", qty: 10, avg_cost: 90, current_price: 100, stop_loss: 92, initial_stop_loss: 88, price_target: 120, highest_price: 101 }],
    openLots: [{ symbol: "ABC", market: "us", qty: 10, order_side: "buy", closed_at: null }],
  });
  return buildShadowBookSnapshot(buildSeedSnapshotInput({ market: "us", session: "2026-09-25", seed, benchmarkClose: 500 }));
}

function makeDeps(overrides: Partial<AtrForwardDeps> = {}, written: ShadowBookSnapshotRow[] = []): AtrForwardDeps {
  const raw = new Map<string, YahooRawReplaySeries | null>([
    ["ABC", series([["2026-09-28", 101, 103, 100, 102], ["2026-09-29", 102, 104, 101, 103]])],
    ["VOO", series([["2026-09-25", 500, 501, 499, 500], ["2026-09-28", 501, 506, 500, 505], ["2026-09-29", 505, 508, 504, 507]])],
  ]);
  return {
    market: "us", now: NOW,
    expectedLatestSession: () => "2026-09-28",
    sessionsBetween: (a, b) => expectedMarketSessionsBetween("us", a, b),
    loadPriorRows: async () => [seedRow(), ...written],
    loadSeedSource: async () => ({ cashBalance: 500, reportedNav: 1500, marksUpdatedAt: "2026-09-25T20:15:00Z", positions: [], openLots: [] }),
    benchmarkSymbol: "VOO",
    loadRawSeries: async (symbols) => new Map(symbols.map((symbol) => [symbol, raw.get(symbol) ?? null])),
    loadLotRows: async () => [],
    loadAtrBySignal: async () => ({}),
    loadActionLedger: async () => [],
    loadCoverage: async () => coverage("ABC"),
    writeSnapshot: async (row) => { written.push(row); return "inserted"; },
    ...overrides,
  };
}

describe("runAtrForwardCollection", () => {
  it("seeds an identical two-arm book at the latest completed session", async () => {
    const written: ShadowBookSnapshotRow[] = [];
    const seedSource = {
      cashBalance: 500, reportedNav: 1500, marksUpdatedAt: "2026-09-25T20:15:00Z",
      positions: [{ symbol: "ABC", market: "us", qty: 10, avg_cost: 90, current_price: 100, stop_loss: 92, initial_stop_loss: 88, price_target: 120, highest_price: 101 }],
      openLots: [{ symbol: "ABC", market: "us", qty: 10, order_side: "buy", closed_at: null }],
    };
    const result = await runAtrForwardCollection(makeDeps({
      expectedLatestSession: () => "2026-09-25", loadPriorRows: async () => [], loadSeedSource: async () => seedSource,
    }, written));
    expect(result).toMatchObject({ status: "collected", written: ["2026-09-25"], details: { mode: "seed", positionCount: 1 } });
    expect(written).toHaveLength(1);
    expect(written[0].blockers.join(" ")).toContain("Seed anchor only");
    expect(written[0].baseline_state).toEqual(written[0].variant_state);
  });

  it("refuses to seed from marks written before the session, and from an empty book", async () => {
    const stale = await runAtrForwardCollection(makeDeps({
      expectedLatestSession: () => "2026-09-28", loadPriorRows: async () => [],
      loadSeedSource: async () => ({ cashBalance: 500, reportedNav: 1500, marksUpdatedAt: "2026-09-25T20:15:00Z", positions: [], openLots: [] }),
    }));
    expect(stale.status).toBe("blocked");
    expect(stale.blockers[0]).toContain("before session 2026-09-28");

    const empty = await runAtrForwardCollection(makeDeps({
      expectedLatestSession: () => "2026-09-25", loadPriorRows: async () => [],
      loadSeedSource: async () => ({ cashBalance: 500, reportedNav: 500, marksUpdatedAt: "2026-09-25T20:15:00Z", positions: [], openLots: [] }),
    }));
    expect(empty.status).toBe("blocked");
    expect(empty.blockers[0]).toContain("No open US paper positions");
  });

  it("advances one session with identical arms when there are no entries", async () => {
    const written: ShadowBookSnapshotRow[] = [];
    const result = await runAtrForwardCollection(makeDeps({}, written));
    expect(result).toMatchObject({ status: "collected", written: ["2026-09-28"], observedSession: "2026-09-28" });
    const row = written[0];
    expect(row.baseline_nav).toBeCloseTo(500 + 10 * 102);
    expect(row.variant_nav).toBeCloseTo(row.baseline_nav);
    expect(row.benchmark_nav).toBe(505);
    expect(row.net_incremental_return_pct).toBeCloseTo(0);
  });

  it("is a no-op when already at the latest completed session", async () => {
    const written: ShadowBookSnapshotRow[] = [];
    const result = await runAtrForwardCollection(makeDeps({ expectedLatestSession: () => "2026-09-25" }, written));
    expect(result).toMatchObject({ status: "collected", written: [], details: { mode: "current" } });
    expect(written).toHaveLength(0);
  });

  it("gives the arms different stops only for a new entry with a decision-time ATR", async () => {
    const written: ShadowBookSnapshotRow[] = [];
    const raw = new Map<string, YahooRawReplaySeries | null>([
      ["ABC", series([["2026-09-28", 101, 103, 100, 102]])],
      ["NEW", series([["2026-09-28", 50, 51, 49, 50.5]])],
      ["VOO", series([["2026-09-28", 501, 506, 500, 505]])],
    ]);
    const result = await runAtrForwardCollection(makeDeps({
      loadRawSeries: async (symbols) => new Map(symbols.map((symbol) => [symbol, raw.get(symbol) ?? null])),
      loadLotRows: async () => [{
        id: "lot-1", market: "us", symbol: "NEW", order_side: "buy", qty: 1, fill_price: 50, executed_at: "2026-09-28T15:00:00Z",
        signal_id: "sig-1", paper_event_id: 7, position_role: "alpha", stop_loss: 46, take_profit: 60,
      }],
      loadAtrBySignal: async () => ({ "sig-1": 1 }),
      loadCoverage: async () => [...coverage("ABC"), ...coverage("NEW")],
    }, written));
    expect(result.status).toBe("collected");
    const row = written[0];
    const stopOf = (state: any) => state.positions.find((p: any) => p.symbol === "NEW").replayState.initialStopLoss;
    expect(stopOf(row.baseline_state)).toBe(46);
    expect(stopOf(row.variant_state)).toBeCloseTo(50 - 2.8 * 1);
    expect((row.point_in_time_inputs as any).decisionIds.some((id: string) => id.startsWith("paper-entry:"))).toBe(true);
  });

  it("holds an entry with no decision-time ATR in BOTH arms on the baseline stop (matched population)", async () => {
    const written: ShadowBookSnapshotRow[] = [];
    const raw = new Map<string, YahooRawReplaySeries | null>([
      ["ABC", series([["2026-09-28", 101, 103, 100, 102]])],
      ["NEW", series([["2026-09-28", 50, 51, 49, 50.5]])],
      ["VOO", series([["2026-09-28", 501, 506, 500, 505]])],
    ]);
    await runAtrForwardCollection(makeDeps({
      loadRawSeries: async (symbols) => new Map(symbols.map((symbol) => [symbol, raw.get(symbol) ?? null])),
      loadLotRows: async () => [{
        id: "lot-1", market: "us", symbol: "NEW", order_side: "buy", qty: 1, fill_price: 50, executed_at: "2026-09-28T15:00:00Z",
        signal_id: "sig-1", paper_event_id: 7, position_role: "alpha", stop_loss: 46, take_profit: 60,
      }],
      loadAtrBySignal: async () => ({}),
      loadCoverage: async () => [...coverage("ABC"), ...coverage("NEW")],
    }, written));
    const row = written[0];
    expect(row.baseline_state.positions.map((p) => p.symbol)).toEqual(["ABC", "NEW"]);
    expect(row.variant_state.positions.map((p) => p.symbol)).toEqual(["ABC", "NEW"]);
    const stopOf = (state: any) => state.positions.find((p: any) => p.symbol === "NEW").replayState;
    expect(stopOf(row.variant_state)).toEqual(stopOf(row.baseline_state));
    expect(stopOf(row.variant_state).initialStopLoss).toBe(46);
    expect(row.net_incremental_return_pct).toBeCloseTo(0);
  });

  it("credits a validated dividend to both arms instead of stalling the shadow", async () => {
    const written: ShadowBookSnapshotRow[] = [];
    const abc = series([["2026-09-28", 101, 103, 100, 102]]);
    abc.corporateActions = [{ symbol: "ABC", session: "2026-09-28", type: "dividend", dividendPerShare: 0.5 }];
    const result = await runAtrForwardCollection(makeDeps({
      loadRawSeries: async () => new Map<string, YahooRawReplaySeries | null>([["ABC", abc], ["VOO", series([["2026-09-28", 501, 506, 500, 505]])]]),
      loadActionLedger: async () => [{ symbol: "ABC", action_type: "dividend", ex_date: "2026-09-28", dividend_amount: 0.5 }],
    }, written));
    expect(result.status).toBe("collected");
    expect(written[0].baseline_nav).toBeCloseTo(500 + 10 * 102 + 5);
    expect(written[0].variant_nav).toBeCloseTo(written[0].baseline_nav);
  });

  it("blocks and writes nothing when a raw bar, the benchmark, or corporate-action coverage is missing", async () => {
    const missingBar = await runAtrForwardCollection(makeDeps({
      loadRawSeries: async () => new Map<string, YahooRawReplaySeries | null>([["ABC", series([["2026-09-25", 100, 101, 99, 100]])], ["VOO", series([["2026-09-28", 501, 506, 500, 505]])]]),
    }));
    expect(missingBar).toMatchObject({ status: "blocked", written: [] });
    expect(missingBar.blockers[0]).toContain("no bar for 2026-09-28");

    const noBenchmark = await runAtrForwardCollection(makeDeps({
      loadRawSeries: async () => new Map<string, YahooRawReplaySeries | null>([["ABC", series([["2026-09-28", 101, 103, 100, 102]])], ["VOO", null]]),
    }));
    expect(noBenchmark.status).toBe("blocked");
    expect(noBenchmark.blockers[0]).toContain("benchmark close");

    const noCoverage = await runAtrForwardCollection(makeDeps({ loadCoverage: async () => [] }));
    expect(noCoverage).toMatchObject({ status: "blocked", written: [] });
    expect(noCoverage.blockers[0]).toContain("lacks fresh complete source coverage");
  });

  it("blocks when a Yahoo action disagrees with the persisted ledger", async () => {
    const withSplit = series([["2026-09-28", 51, 52, 50, 51.5]]);
    withSplit.corporateActions = [{ symbol: "ABC", session: "2026-09-28", type: "split", splitRatio: 2 }];
    const result = await runAtrForwardCollection(makeDeps({
      loadRawSeries: async () => new Map<string, YahooRawReplaySeries | null>([["ABC", withSplit], ["VOO", series([["2026-09-28", 501, 506, 500, 505]])]]),
    }));
    expect(result.status).toBe("blocked");
    expect(result.blockers[0]).toContain("disagrees between raw-bar provider and persisted action ledger");
  });

  it("catches up at most the per-run session cap and reports the remainder", async () => {
    const written: ShadowBookSnapshotRow[] = [];
    const bars = ["2026-09-28", "2026-09-29"].map((d) => [d, 101, 103, 100, 102] as [string, number, number, number, number]);
    const result = await runAtrForwardCollection(makeDeps({
      expectedLatestSession: () => "2026-09-29",
      loadRawSeries: async () => new Map<string, YahooRawReplaySeries | null>([["ABC", series(bars)], ["VOO", series([["2026-09-28", 501, 506, 500, 505], ["2026-09-29", 505, 508, 504, 507]])]]),
    }, written));
    expect(result.written).toEqual(["2026-09-28", "2026-09-29"]);
    expect(written.map((r) => r.session_date)).toEqual(["2026-09-28", "2026-09-29"]);
    expect(written[1].window_start).toBe("2026-09-25");
  });
});
