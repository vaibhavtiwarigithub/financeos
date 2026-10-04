import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// THE DEFECT THIS ROUTE EXISTS FOR, and what this test pins.
//
// prewarmPriceCache had exactly ONE caller: the research cron, which runs
// PRE-CLOSE (13:00 UTC for US). expectedNewestSession() names today's session
// only AFTER the close, so that run can never see the current session as
// missing — it reported "134/139 already fresh" while the freshness monitor at
// 20:00 UTC correctly reported 86/103 scopes stale. Nothing refetched between
// the close and kairos-position-monitor at 20:15, so marks, stop checks and
// target checks ran against the PREVIOUS session's close.
//
// The first attempt at this fix scheduled /api/agents/prewarm post-close. That
// is the EVIDENCE warmer (av_cache fundamentals/sentiment/insider) — it touches
// no price bars, so it would have fixed nothing while doubling the daily
// Alpha Vantage / Massive / GDELT load. Hence the assertions below that this
// route calls prewarmPriceCache and not prewarmSymbol.

const h = vi.hoisted(() => ({
  prewarm: vi.fn(),
  positions: vi.fn(),
  decisions: vi.fn(),
  disabled: vi.fn(),
  report: vi.fn(),
  resolve: vi.fn(),
}));

vi.mock("@/lib/auth/cron", () => ({ verifyCronSecret: () => true }));
vi.mock("@/lib/chart-data", () => ({ prewarmPriceCache: h.prewarm }));
vi.mock("@/lib/system-health", () => ({ reportIssue: h.report, resolveIssue: h.resolve }));
vi.mock("@/lib/supabase/service", () => ({
  createServiceClient: () => ({
    from: (table: string) => ({
      select: () => ({
        eq: () => ({
          is: () => ({ gt: () => ({ limit: async () => h.positions() }) }),
          gte: () => ({ limit: async () => h.decisions() }),
          eq: () => ({ limit: async () => h.disabled() }), // research-disabled watchlist names
        }),
      }),
    }),
  }),
}));

import { POST } from "@/app/api/agents/price-prewarm/route";

const call = (market = "us") =>
  POST(new NextRequest(`http://localhost/api/agents/price-prewarm?market=${market}`, { method: "POST" }));

beforeEach(() => {
  h.prewarm.mockReset().mockResolvedValue({ ok: 3, failed: 0, skipped: 0, alreadyFresh: 5, failedSymbols: [], skippedSymbols: [] });
  h.positions.mockReset().mockReturnValue({ data: [{ symbol: "AAPL" }] });
  h.decisions.mockReset().mockReturnValue({ data: [{ symbol: "MSFT" }, { symbol: "AAPL" }] });
  h.disabled.mockReset().mockReturnValue({ data: [] });
  h.report.mockReset().mockResolvedValue(undefined);
  h.resolve.mockReset().mockResolvedValue(undefined);
});

describe("scope matches what the freshness contract demands", () => {
  it("prewarms open positions AND the recent-decision tail, de-duplicated", () => {
    return call().then(async res => {
      expect(res.status).toBe(200);
      const symbols = h.prewarm.mock.calls[0][0] as string[];
      expect(symbols).toContain("AAPL");
      expect(symbols).toContain("MSFT");
      expect(symbols.filter(s => s === "AAPL")).toHaveLength(1);
    });
  });

  it("open positions come FIRST — the prewarm is deadline-bounded, so order is the budget policy", async () => {
    await call();
    const symbols = h.prewarm.mock.calls[0][0] as string[];
    expect(symbols[0]).toBe("AAPL");
  });

  it("US includes benchmark symbols; India does not", async () => {
    await call("us");
    expect(h.prewarm.mock.calls[0][0]).toContain("SPY");
    h.prewarm.mockClear();
    await call("india");
    expect(h.prewarm.mock.calls[0][0]).not.toContain("SPY");
  });
});

describe("a partial refresh is reported, never hidden", () => {
  it("raises a warn when symbols were skipped for time", async () => {
    h.prewarm.mockResolvedValue({ ok: 1, failed: 0, skipped: 7, alreadyFresh: 0 });
    await call();
    expect(h.report).toHaveBeenCalledOnce();
    expect(h.report.mock.calls[0][0].issueKey).toBe("price-prewarm-incomplete:us");
  });

  it("raises a warn when symbols failed", async () => {
    h.prewarm.mockResolvedValue({ ok: 1, failed: 2, skipped: 0, alreadyFresh: 0, failedSymbols: ["XAR", "SKHY"], skippedSymbols: [] });
    await call();
    expect(h.report).toHaveBeenCalledOnce();
    expect(h.report.mock.calls[0][0].detail).toContain("failed:XAR, failed:SKHY");
  });

  it("treats a Supabase scope error as unavailable instead of a clean empty universe", async () => {
    h.positions.mockReturnValue({ data: null, error: { message: "timeout" } });
    const res = await call();
    expect(res.status).toBe(503);
    expect(h.prewarm).not.toHaveBeenCalled();
    expect(h.report).toHaveBeenCalledWith(expect.objectContaining({
      issueKey: "price-prewarm-scope-error:us",
      title: expect.stringContaining("could not resolve its US scope"),
    }), expect.anything());
  });

  it("resolves the issue on a clean run", async () => {
    await call();
    expect(h.report).not.toHaveBeenCalled();
    expect(h.resolve).toHaveBeenCalledWith("price-prewarm-incomplete:us", expect.anything());
  });

  it("fails loudly rather than reporting a clean run over an empty scope", async () => {
    h.positions.mockImplementation(() => { throw new Error("db down"); });
    const res = await call();
    expect(res.status).toBe(503);
    expect(h.prewarm).not.toHaveBeenCalled();
  });
});

describe("it refreshes PRICE BARS, not evidence", () => {
  const src = readFileSync(join(process.cwd(), "app/api/agents/price-prewarm/route.ts"), "utf8");

  it("calls prewarmPriceCache and never prewarmSymbol", () => {
    expect(src).toContain("prewarmPriceCache");
    expect(src).not.toMatch(/\bprewarmSymbol\b\s*\(/);
  });

  it("touches no scoring, signal, proposal or order path", () => {
    for (const forbidden of ["agent_signals", "trade_proposals", "broker_orders", "paper_trades", "strategy_config"]) {
      expect(src, `price-prewarm must not touch ${forbidden}`).not.toContain(forbidden);
    }
  });
});

describe("research-disabled names", () => {
  it("are dropped from the scope unless held (delisted ABB/IRBT/TMHC failed every run for weeks)", async () => {
    h.positions.mockReturnValue({ data: [{ symbol: "AAPL" }, { symbol: "IRBT" }] });
    h.decisions.mockReturnValue({ data: [{ symbol: "MSFT" }, { symbol: "ABB" }, { symbol: "IRBT" }] });
    h.disabled.mockReturnValue({ data: [{ symbol: "ABB" }, { symbol: "IRBT" }] });
    const res = await call("us");
    expect(res.status).toBe(200);
    const scope: string[] = h.prewarm.mock.calls[0][0];
    expect(scope).toContain("MSFT");
    expect(scope).toContain("IRBT"); // held, so it stays
    expect(scope).not.toContain("ABB");
  });
  it("a failed disabled-watchlist read is reported as an unavailable scope, not an empty one", async () => {
    h.disabled.mockReturnValue({ data: null, error: { message: "boom" } });
    const res = await call("us");
    expect(res.status).toBe(503);
  });
});
