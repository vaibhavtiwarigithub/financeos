import { beforeEach, describe, expect, it, vi } from "vitest";

const { getCrumb, providerCachedFetch } = vi.hoisted(() => ({
  getCrumb: vi.fn(),
  providerCachedFetch: vi.fn(),
}));

vi.mock("@/lib/data/yahoo-crumb", () => ({ getCrumb }));
vi.mock("@/lib/data/provider-fetch", () => ({ providerCachedFetch }));

import { deriveReturnOnEquity, fetchIndiaOverview } from "@/lib/india-data";

describe("Yahoo India fundamentals numeric normalization", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getCrumb.mockResolvedValue({ cookie: "cookie", crumb: "crumb" });
  });

  it("keeps numeric raw values and rejects display-only or malformed objects", async () => {
    providerCachedFetch.mockResolvedValue({
      quoteSummary: {
        result: [{
          summaryDetail: { trailingPE: { raw: 18.5, fmt: "18.50" } },
          financialData: {
            profitMargins: { raw: 0.21, fmt: "21.00%" },
            returnOnEquity: { fmt: "36.14%" },
            revenueGrowth: { raw: { value: 0.12 }, fmt: "12.00%" },
          },
          defaultKeyStatistics: {
            pegRatio: { fmt: "1.20" },
            trailingEps: { raw: 4.25, fmt: "4.25" },
          },
          assetProfile: { sector: "Technology" },
          price: {},
        }],
      },
    });

    const overview = await fetchIndiaOverview("TEST.NS");

    expect(overview.PERatio).toBe("18.5");
    expect(overview.ProfitMargin).toBe("0.21");
    expect(overview.EPS).toBe("4.25");
    expect(overview.Sector).toBe("Technology");
    expect(overview).not.toHaveProperty("ReturnOnEquityTTM");
    expect(overview).not.toHaveProperty("PEGRatio");
    expect(overview).not.toHaveProperty("QuarterlyRevenueGrowthYOY");
    expect(Object.values(overview)).not.toContain("[object Object]");
  });

  it("accepts finite scalar and Yahoo raw values for ROE and PEG", async () => {
    providerCachedFetch.mockResolvedValue({
      quoteSummary: {
        result: [{
          financialData: { returnOnEquity: { raw: 0.3614 } },
          defaultKeyStatistics: { pegRatio: 1.25 },
        }],
      },
    });

    const overview = await fetchIndiaOverview("TEST.NS");

    expect(overview.ReturnOnEquityTTM).toBe("0.3614");
    expect(overview.PEGRatio).toBe("1.25");
  });

  it("does not turn a missing ROE primitive into a fabricated zero", () => {
    expect(deriveReturnOnEquity({
      netIncomeToCommon: null,
      bookValue: 12,
      sharesOutstanding: 100,
    })).toBeNull();
  });
});
