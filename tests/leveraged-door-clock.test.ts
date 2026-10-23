import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DeterministicQuote } from "@/lib/data/quotes";

const mocks = vi.hoisted(() => ({
  authorized: true,
  held: true,
  heldPolicy: null as string | null,
  tightRisk: false,
  setupState: "ready",
  liveHeld: false,
  allowLiveEntryForTest: false,
  liveBook: [] as Array<{ symbol: string; qty: unknown; current_price: unknown }>,
  prior: 0,
  evidenceDelayMs: 0,
  updates: [] as unknown[],
  records: [] as unknown[],
  quote: vi.fn(),
  rpc: vi.fn(),
  researchGate: vi.fn(),
  report: vi.fn(),
  resolve: vi.fn(),
  brokerSubmit: vi.fn(),
  brokerCancel: vi.fn(),
}));

vi.mock("@/lib/auth/cron", () => ({ verifyCronSecret: () => mocks.authorized }));
vi.mock("@/lib/system-health", () => ({ reportIssue: mocks.report, resolveIssue: mocks.resolve }));
vi.mock("@/lib/data/leveraged-intraday-quotes", () => ({
  getLeveragedIntradayQuote: mocks.quote, getLeveragedExecutableQuote: mocks.quote,
}));
vi.mock("@/lib/brokers/adapters/robinhood", () => ({ robinhoodAdapter: () => ({ submitOrder: mocks.brokerSubmit }) }));
vi.mock("@/lib/protective/placement-worker", () => ({
  placeProtectiveStop: mocks.brokerSubmit, cancelProtectiveStop: mocks.brokerCancel,
  markProtectiveExitUnresolved: vi.fn(),
}));
vi.mock("@/lib/robinhood-mcp", () => ({
  queryRobinhoodOrder: async () => ({ ok: true, status: "submitted", raw: {} }),
  robinhoodHeldQty: vi.fn(),
}));
vi.mock("@/lib/protective/robinhood-readback", () => ({
  verifyRobinhoodRestingStop: () => true, confirmedRobinhoodStopExit: vi.fn(),
}));
vi.mock("@/lib/trading/leveraged-live-kernel", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/trading/leveraged-live-kernel")>();
  return { ...actual, evaluateLeveragedLiveEntry: (input: Parameters<typeof actual.evaluateLeveragedLiveEntry>[0]) =>
    mocks.allowLiveEntryForTest ? { go: true } : actual.evaluateLeveragedLiveEntry(input) };
});
vi.mock("@/lib/data/candles", () => ({ fetchUsCandles: async () => ({ source: "massive", candles:
  Array.from({ length: 60 }, () => ({ date: "2026-10-21", open: 100, close: 100, low: 98, high: 101, volume: 1e6 })),
}) }));
vi.mock("@/lib/data/technicals", () => ({
  computeTechnicals: () => ({ atr14: 2, priceVsEma20: "above", priceVsEma50: "above", trend20d: "up" }),
  detectBreakdownVeto: () => ({ vetoed: false }),
}));
vi.mock("@/lib/trading/leveraged-etf-shadow-features", () => ({
  computeLeveragedShadowFeatures: () => ({ dollarVolume: 100e6 }),
}));
vi.mock("@/lib/trading-mandate", () => ({ loadTradingMandate: async () => ({ score_threshold: 60 }) }));
vi.mock("@/lib/trading/leveraged-door-signal", () => ({
  loadLatestResearchSignal: async () => {
    vi.setSystemTime(Date.now() + mocks.evidenceDelayMs);
    return { signal: {}, error: null };
  },
  evaluateLeveragedResearchGate: mocks.researchGate,
}));
vi.mock("@/lib/trading/leveraged-intraday", async (original) => ({
  ...await original<typeof import("@/lib/trading/leveraged-intraday")>(),
  loadLeveragedIntradaySetup: async () => ({ state: mocks.setupState, atr: 2, structuralStop: 98,
    reason: "proxy_direction_not_confirmed", signalAt: Date.now() - 1000,
    evidence: { openingHigh: 99, etf_vwap: 99, diagnostic: "x".repeat(700) } }),
}));

// All persistence and provider I/O is mocked; these tests cannot place an order,
// modify a real position or consume a broker/provider quota.
vi.mock("@/lib/supabase/service", () => ({ createServiceClient: () => ({
  rpc: mocks.rpc,
  from(table: string) {
    let op = "select";
    let singleRead = false;
    const data = () => op !== "select" ? null
      : table === "agent_runs" ? { completed_at: new Date(mocks.prior).toISOString() }
      : table === "paper_positions" ? (mocks.held ? {
        id: "test-position", qty: 1, avg_cost: 100, current_price: 100,
        stop_loss: mocks.tightRisk ? 99.7 : 90, initial_stop_loss: mocks.tightRisk ? 99.7 : 90,
        highest_price: mocks.tightRisk ? 101 : 100, price_target: 120, entry_policy_version: mocks.heldPolicy,
      } : null)
      : table === "paper_portfolio" ? { nav: 10000, cash_balance: 10000 }
      : table === "leveraged_live_positions" ? (singleRead ? (mocks.liveHeld ? {
        id: "test-live-position", qty: 1, avg_cost: 100, current_price: 100,
        stop_loss: 90, initial_stop_loss: 90, highest_price: 100, price_target: 120,
        protective_order_id: "test-protection", broker_account_id: "test-account",
      } : null) : mocks.liveBook)
      : table === "protective_orders" ? { status: "active", broker_order_id: "test-stop", protected_qty: 1, trigger_price: 90 }
      : table === "strategy_config" ? { active_account_us: "test-account", leveraged_sleeve_live_lease_usd: 50 }
      : null;
    const result = () => ({ data: data(), error: null });
    const chain: any = {
      select: () => chain, eq: () => chain, in: () => chain, not: () => chain,
      is: () => chain, like: () => chain,
      order: () => chain, limit: () => chain,
      maybeSingle: async () => { singleRead = true; return result(); },
      insert: (value: unknown) => { op = "insert"; mocks.records.push(value); return chain; },
      update: (value: unknown) => { op = "update"; mocks.updates.push(value); return chain; },
      then: (resolve: (value: unknown) => unknown) => Promise.resolve(result()).then(resolve),
    };
    return chain;
  },
}) }));

import { GET as soxl } from "@/app/api/agents/soxl/cron/route";
import { GET as tqqq } from "@/app/api/agents/tqqq/cron/route";
import { GET as sqqq } from "@/app/api/agents/sqqq/cron/route";
import { GET as soxs } from "@/app/api/agents/soxs/cron/route";
import { GET as live } from "@/app/api/agents/leveraged-live/cron/route";

const doors = [
  { symbol: "SOXL", handler: soxl, minute: 0 },
  { symbol: "TQQQ", handler: tqqq, minute: 0 },
  { symbol: "SQQQ", handler: sqqq, minute: 0 },
  { symbol: "SOXS", handler: soxs, minute: 0 },
];
const request = {} as Parameters<typeof soxl>[0];
let start: number;

function quote(symbol: string, observedAt: number): DeterministicQuote {
  return { symbol, price: 100.01, bid: 100, ask: 100.02, source: "robinhood_mcp",
    observedAt: new Date(observedAt).toISOString(), retrievedAt: new Date(Date.now()).toISOString(),
    change: null, changePct: null, stale: false, dayHigh: null, dayLow: null };
}

beforeEach(() => {
  vi.useFakeTimers();
  start = Date.parse("2026-10-22T15:00:00Z");
  vi.setSystemTime(start);
  mocks.authorized = true;
  mocks.held = true;
  mocks.heldPolicy = null;
  mocks.tightRisk = false;
  mocks.setupState = "ready";
  mocks.liveHeld = false;
  mocks.allowLiveEntryForTest = false;
  mocks.liveBook = [];
  mocks.prior = start - 60_000;
  mocks.evidenceDelayMs = 0;
  mocks.updates.length = 0;
  mocks.records.length = 0;
  vi.clearAllMocks();
  mocks.researchGate.mockReturnValue({ ok: true, signalId: "test-signal", score: 80 });
  mocks.rpc.mockResolvedValue({ data: { ok: true, trade_id: "test-trade" }, error: null });
  mocks.brokerSubmit.mockImplementation(() => { throw new Error("unexpected broker mutation in clock test"); });
  mocks.brokerCancel.mockImplementation(() => { throw new Error("unexpected broker cancellation in clock test"); });
  mocks.quote.mockImplementation(async (symbol: string) => {
    vi.setSystemTime(start + 4000);
    return quote(symbol, start + 3000);
  });
});

describe.each(doors)("$symbol recorded paper trail routing", ({ symbol, handler }) => {
  it("persists a complete, parseable setup reason through the actual route", async () => {
    mocks.held = false;
    mocks.setupState = "wait";
    const body = await (await handler(request)).json();
    expect(body).toMatchObject({ status: "no_entry", reason: "proxy_direction_not_confirmed" });
    expect(mocks.records).toHaveLength(1);
    const row = mocks.records[0] as { result_summary: string };
    expect(row.result_summary.length).toBeGreaterThan(500);
    expect(JSON.parse(row.result_summary)).toEqual(body);
    expect(mocks.brokerSubmit).not.toHaveBeenCalled();
  });
  it.each([true, false])("uses tight-risk protection only for recorded intraday lots (%s)", async (intraday) => {
    mocks.tightRisk = true;
    mocks.heldPolicy = intraday ? `${symbol.toLowerCase()}-paper-intraday-v3` : null;
    mocks.quote.mockImplementation(async () => ({ ...quote(symbol, start - 1000), price: 100.6 }));
    const body = await (await handler(request)).json();
    expect(body.status).toBe(intraday ? "exited" : "held");
    if (intraday) expect(body.action).toBe("stop_full");
    else expect(mocks.rpc).not.toHaveBeenCalled();
    expect(mocks.brokerSubmit).not.toHaveBeenCalled();
    expect(mocks.brokerCancel).not.toHaveBeenCalled();
  });
});

describe("dormant live leveraged clock and health", () => {
  it.each([null, undefined, 0, -1, NaN, "not-a-price"])("refuses an unknown or invalid live holding price (%s) instead of using quantity", async (price) => {
    mocks.allowLiveEntryForTest = true;
    mocks.liveBook = [{ symbol: "TQQQ", qty: 1, current_price: price }];
    const body = await (await live(request)).json();
    expect(body.results.SOXL).toMatchObject({ status: "no_entry", reason: "invalid_position_mark" });
    expect(mocks.brokerSubmit).not.toHaveBeenCalled();
    expect(mocks.brokerCancel).not.toHaveBeenCalled();
  });

  it("uses a valid live mark to exhaust the existing dollar lease", async () => {
    mocks.allowLiveEntryForTest = true;
    mocks.liveBook = [{ symbol: "TQQQ", qty: 1, current_price: 100 }];
    const body = await (await live(request)).json();
    expect(body.results.SOXL).toMatchObject({ status: "no_entry", reason: "no_sleeve_capacity" });
    expect(mocks.brokerSubmit).not.toHaveBeenCalled();
  });

  it("checks each symbol against its post-fetch clock without placing or canceling orders", async () => {
    mocks.liveHeld = true;
    mocks.quote.mockImplementation(async (symbol: string) => {
      const fetchStart = Date.now();
      vi.setSystemTime(fetchStart + 4000);
      return quote(symbol, fetchStart + 3000);
    });
    const body = await (await live(request)).json();
    for (const { symbol } of doors) expect(body.results[symbol]).toMatchObject({ status: "held" });
    expect(mocks.updates).toHaveLength(4);
    expect(mocks.records).toEqual([expect.objectContaining({ status: "done" })]);
    expect(mocks.brokerSubmit).not.toHaveBeenCalled();
    expect(mocks.brokerCancel).not.toHaveBeenCalled();
  });

  it.each(["future", "stale"])("does not record live %s-quote monitor failures as healthy liveness", async (kind) => {
    mocks.liveHeld = true;
    mocks.quote.mockImplementation(async (symbol: string) => {
      const fetchStart = Date.now();
      vi.setSystemTime(fetchStart + 4000);
      return quote(symbol, kind === "future" ? fetchStart + 5000 : fetchStart - 16 * 60_000);
    });
    const body = await (await live(request)).json();
    for (const { symbol } of doors) expect(body.results[symbol]).toMatchObject({ status: "monitor_failed" });
    expect(mocks.records).toEqual([expect.objectContaining({ status: "error" })]);
    expect(mocks.updates).toHaveLength(0);
    expect(mocks.brokerSubmit).not.toHaveBeenCalled();
    expect(mocks.brokerCancel).not.toHaveBeenCalled();
  });

  it("does not open a live position when deployment/worker gates are closed", async () => {
    const body = await (await live(request)).json();
    expect(body.results.SOXL).toMatchObject({ status: "no_entry" });
    expect(mocks.quote).not.toHaveBeenCalled();
    expect(mocks.brokerSubmit).not.toHaveBeenCalled();
    expect(mocks.brokerCancel).not.toHaveBeenCalled();
  });
});
afterEach(() => vi.useRealTimers());

describe.each(doors)("$symbol paper decision clock", ({ handler, symbol, minute }) => {
  it("monitors a venue event received during the request without replacing its timestamp", async () => {
    const body = await (await handler(request)).json();
    expect(body).toMatchObject({ status: "held" });
    expect(mocks.updates).toHaveLength(1);
    expect(mocks.report).not.toHaveBeenCalled();
    expect(mocks.rpc).not.toHaveBeenCalled();
    expect(mocks.records).toEqual([expect.objectContaining({ status: "done" })]);
  });

  it.each(["future", "stale", "missing"])("still refuses %s venue timestamps without updating positions", async (kind) => {
    mocks.quote.mockImplementation(async () => {
      vi.setSystemTime(start + 4000);
      const q = quote(symbol, kind === "future" ? start + 5000 : start - 16 * 60_000);
      return kind === "missing" ? { ...q, observedAt: undefined } : q;
    });
    expect(await (await handler(request)).json()).toMatchObject({ status: "monitor_failed", reason: "data_unavailable" });
    expect(mocks.updates).toHaveLength(0);
    expect(mocks.rpc).not.toHaveBeenCalled();
    expect(mocks.records).toEqual([expect.objectContaining({ status: "error" })]);
  });

  it("still executes the modeled paper stop decision on a valid fresh quote", async () => {
    mocks.quote.mockImplementation(async () => {
      vi.setSystemTime(start + 4000);
      return { ...quote(symbol, start + 3000), price: 80 };
    });
    expect(await (await handler(request)).json()).toMatchObject({ status: "exited", action: "stop_full" });
    expect(mocks.rpc).toHaveBeenCalledWith("execute_paper_exit", expect.objectContaining({ p_exit_price: 80 }));
  });

  it("allows a fresh post-request venue event at entry and preserves its provenance", async () => {
    mocks.held = false;
    start += minute * 60_000;
    vi.setSystemTime(start);
    expect(await (await handler(request)).json()).toMatchObject({ status: "entered" });
    expect(mocks.rpc).toHaveBeenCalledWith(`execute_${symbol.toLowerCase()}_paper_fill`, expect.objectContaining({
      p_price_retrieved_at: new Date(start + 3000).toISOString(), p_bid: 100, p_ask: 100.02,
    }));
    expect(mocks.researchGate).toHaveBeenCalledWith({}, expect.objectContaining({ now: start + 4000 }));
  });

  it("does not enter if the fetch finishes after the entry window", async () => {
    mocks.held = false;
    start = Date.parse("2026-10-22T19:29:59Z");
    vi.setSystemTime(start);
    expect(await (await handler(request)).json()).toMatchObject({ status: "no_entry", reason: "outside_entry_window" });
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it("rechecks the window after slower downstream research reads too", async () => {
    mocks.held = false;
    start = Date.parse("2026-10-22T19:29:50Z");
    vi.setSystemTime(start);
    mocks.evidenceDelayMs = 10_000;
    expect(await (await handler(request)).json()).toMatchObject({ status: "no_entry", reason: "outside_entry_window" });
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it("rejects a quote that ages past the existing 15-minute bound during downstream I/O", async () => {
    mocks.held = false;
    start += minute * 60_000;
    vi.setSystemTime(start);
    mocks.quote.mockImplementation(async () => quote(symbol, start - 15 * 60_000 + 1000));
    mocks.evidenceDelayMs = 2000;
    expect(await (await handler(request)).json()).toMatchObject({ status: "no_entry", reason: "invalid_quote" });
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it("does not certify monitoring from a quote older than two minutes", async () => {
    mocks.held = false;
    start += minute * 60_000;
    vi.setSystemTime(start);
    mocks.quote.mockImplementation(async () => quote(symbol, start - 150_000));
    expect(await (await handler(request)).json()).toMatchObject({ status: "no_entry", reason: "invalid_quote", monitorVerified: false });
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it("rejects an expired prior monitor proof at decision time", async () => {
    mocks.held = false;
    start += minute * 60_000;
    vi.setSystemTime(start);
    mocks.prior = start - 24 * 60 * 60_000 + 2000;
    expect(await (await handler(request)).json()).toMatchObject({ status: "no_entry", reason: "monitor_unhealthy" });
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it("retains cron authorization before any provider or persistence work", async () => {
    mocks.authorized = false;
    expect((await handler(request)).status).toBe(401);
    expect(mocks.quote).not.toHaveBeenCalled();
    expect(mocks.records).toHaveLength(0);
    expect(mocks.rpc).not.toHaveBeenCalled();
  });
});
