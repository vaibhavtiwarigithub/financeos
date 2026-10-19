import { describe, expect, it, vi } from "vitest";
import type { ProviderCallContext, ProviderRequest } from "@/lib/evidence/contracts";

const h = vi.hoisted(() => ({ fetchFinnhubOverview: vi.fn() }));
vi.mock("@/lib/data/fundamentals", () => ({
  fetchFinnhubOverview: (...args: unknown[]) => h.fetchFinnhubOverview(...args),
}));

import { finnhubFundamentalsAdapter } from "@/lib/evidence/adapters/finnhub";

const ctx: ProviderCallContext = { market: "us", asOf: "2026-10-19T00:00:00.000Z", timeoutMs: 5000 };
const request = (symbol: string): ProviderRequest => ({ intent: "fundamentals.reported", market: "us", symbol });

describe("Finnhub equity fundamentals applicability", () => {
  it("skips ETFs and crypto before provider I/O", async () => {
    for (const symbol of ["DBA", "GLD", "SOXL", "SOXS", "SOXX", "SQQQ", "TQQQ", "BTC-USD", "ETH-USD", "SOL-USD"]) {
      const result = await finnhubFundamentalsAdapter.fetch(request(symbol), ctx);
      expect(result.ok, symbol).toBe(false);
      expect(result.unavailableReason, symbol).toBe("not_applicable");
    }
    expect(h.fetchFinnhubOverview).not.toHaveBeenCalled();
  });

  it("continues to fetch company equities", async () => {
    h.fetchFinnhubOverview.mockResolvedValue({ Symbol: "AAPL", PERatio: "31.2" });
    const result = await finnhubFundamentalsAdapter.fetch(request("AAPL"), ctx);
    expect(result.ok).toBe(true);
    expect(h.fetchFinnhubOverview).toHaveBeenCalledOnce();
  });
});
