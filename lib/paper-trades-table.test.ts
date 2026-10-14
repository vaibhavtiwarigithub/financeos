import { describe, expect, it } from "vitest";
import { TRADE_COLUMNS, filterByStatus, nextSort, projectTrade, recentlySold, sortTrades, type TradeSortKey } from "@/lib/paper-trades-table";

const NOW = Date.parse("2026-10-14T12:00:00Z");
const trade = (over: Record<string, unknown>) => ({
  symbol: "AAA", order_side: "buy", qty: 10, fill_price: 100, analyst_score: 70, executed_at: "2026-10-01T10:00:00Z",
  closed_at: null, exit_price: null, realized_pnl: null, outcome: null, exit_reason: null, ...over,
});
const derived = { currentAmount: null, currentPrice: null, plan: null };
const proj = (t: any) => projectTrade(t, derived);

describe("paper trades table helpers", () => {
  const rows = [
    trade({ symbol: "OPEN1", executed_at: "2026-10-09T10:00:00Z" }),
    trade({ symbol: "SOLD_TODAY", executed_at: "2026-09-01T10:00:00Z", closed_at: "2026-10-13T11:15:00Z", exit_price: 90, realized_pnl: -100, outcome: "loss", exit_reason: "stop_hit" }),
    trade({ symbol: "OPEN2", executed_at: "2026-10-08T10:00:00Z", analyst_score: null }),
    trade({ symbol: "SOLD_OLD", executed_at: "2026-08-01T10:00:00Z", closed_at: "2026-08-20T11:15:00Z", exit_price: 120, realized_pnl: 200, outcome: "win", exit_reason: "target" }),
  ];

  it("default 'latest activity' puts a position sold today above older open lots (the original complaint)", () => {
    const sorted = sortTrades(rows, proj, "activity", "desc").map((r) => r.symbol);
    expect(sorted.slice(0, 2)).toEqual(["SOLD_TODAY", "OPEN1"]);
    expect(sorted[sorted.length - 1]).toBe("SOLD_OLD");
  });
  it("sorts every column in both directions without throwing, and keeps nulls last", () => {
    for (const col of TRADE_COLUMNS) {
      for (const dir of ["asc", "desc"] as const) {
        const out = sortTrades(rows, proj, col.key, dir);
        expect(out).toHaveLength(rows.length);
      }
    }
    const byScore = sortTrades(rows, proj, "score", "desc").map((r) => r.symbol);
    expect(byScore[byScore.length - 1]).toBe("OPEN2"); // null score last
    const byScoreAsc = sortTrades(rows, proj, "score", "asc").map((r) => r.symbol);
    expect(byScoreAsc[byScoreAsc.length - 1]).toBe("OPEN2"); // still last ascending
  });
  it("sorts sold date, realized P&L and text columns correctly", () => {
    expect(sortTrades(rows, proj, "sold", "desc").map((r) => r.symbol).slice(0, 2)).toEqual(["SOLD_TODAY", "SOLD_OLD"]);
    expect(sortTrades(rows, proj, "realized", "asc").map((r) => r.symbol)[0]).toBe("SOLD_TODAY");
    expect(sortTrades(rows, proj, "symbol", "asc").map((r) => r.symbol)[0]).toBe("OPEN1");
    expect(sortTrades(rows, proj, "outcome", "asc").map((r) => r.symbol)[0]).toBe("SOLD_TODAY"); // alphabetical: loss < open < win
  });
  it("is stable: ties keep server order", () => {
    const same = [trade({ symbol: "A" }), trade({ symbol: "B" }), trade({ symbol: "C" })];
    expect(sortTrades(same, proj, "qty", "desc").map((r) => r.symbol)).toEqual(["A", "B", "C"]);
  });
  it("uses the live mark for open lots and the exit price for sold lots in Exit / Mkt", () => {
    const open = projectTrade(trade({}), { currentAmount: 50, currentPrice: 105, plan: "armed" });
    const sold = projectTrade(rows[1], derived);
    expect(open.exit).toBe(105);
    expect(sold.exit).toBe(90);
    expect(open.current).toBe(50);
  });
  it("clicking a new column starts text A-Z and numbers/dates largest first; clicking again flips", () => {
    expect(nextSort({ key: "activity", dir: "desc" }, "symbol")).toEqual({ key: "symbol", dir: "asc" });
    expect(nextSort({ key: "activity", dir: "desc" }, "realized")).toEqual({ key: "realized", dir: "desc" });
    expect(nextSort({ key: "realized", dir: "desc" }, "realized")).toEqual({ key: "realized", dir: "asc" });
    const keys: TradeSortKey[] = TRADE_COLUMNS.map((c) => c.key);
    expect(new Set(keys).size).toBe(keys.length);
  });
  it("filters open vs sold lots", () => {
    expect(filterByStatus(rows, "open").map((r) => r.symbol)).toEqual(["OPEN1", "OPEN2"]);
    expect(filterByStatus(rows, "sold").map((r) => r.symbol)).toEqual(["SOLD_TODAY", "SOLD_OLD"]);
    expect(filterByStatus(rows, "all")).toHaveLength(4);
  });
  it("groups recent sales by symbol and day, newest first, and ignores old or future-dated ones", () => {
    const sales = recentlySold([
      trade({ symbol: "AAPL", closed_at: "2026-10-13T20:15:06Z", realized_pnl: 3, exit_reason: "partial_target" }),
      trade({ symbol: "AAPL", closed_at: "2026-10-13T20:15:06Z", realized_pnl: 34, exit_reason: "partial_target" }),
      trade({ symbol: "ASML", closed_at: "2026-10-13T20:15:06Z", realized_pnl: -62, exit_reason: "stop_hit_intraday" }),
      trade({ symbol: "OLD", closed_at: "2026-08-01T00:00:00Z", realized_pnl: 9 }),
      trade({ symbol: "FUTURE", closed_at: "2026-12-01T00:00:00Z", realized_pnl: 9 }),
    ], NOW);
    expect(sales.map((s) => s.symbol).sort()).toEqual(["AAPL", "ASML"]);
    const aapl = sales.find((s) => s.symbol === "AAPL")!;
    expect(aapl).toMatchObject({ lots: 2, soldOn: "2026-10-13", reasons: ["partial_target"] });
    expect(aapl.realizedPnl).toBeCloseTo(37, 6);
  });
});
