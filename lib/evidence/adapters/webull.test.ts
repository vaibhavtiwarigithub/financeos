// Golden unit tests — Canonical Evidence Router Webull adapters.
//
// NO NETWORK. `@/lib/data/webull-data` is mocked so fetchWebullAnalyst /
// fetchWebullFinancials return the PARSED shapes the real fetchers would yield
// from the VERIFIED live probe payloads in
// features/data-source-policy/PROBE_RESULTS.md (AAPL, category:US_STOCK).
//
// These lock the load-bearing invariants:
//   • analyst rating derived from the AAPL buckets → 76;
//   • targetPrice = consensus mean (315.57), forecastEps = the reported:false
//     forward estimate (1.89428), NOT a past `actual`;
//   • fundamentals basis is "quarterly" on EVERY field and ratios stay fractions
//     (net_margin 0.266, never rescaled);
//   • both live no-data modes (SPY empty-ok, unknown-symbol error) → genuine_no_data;
//   • validate() rejects prototype-pollution keys → schema_invalid.

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { WebullAnalyst } from "@/lib/data/webull-data";
import type { ProviderCallContext, ProviderRequest } from "@/lib/evidence/contracts";

const h = vi.hoisted(() => ({
  analyst: vi.fn(),
  financials: vi.fn(),
}));

vi.mock("@/lib/data/webull-data", () => ({
  fetchWebullAnalyst: (...a: any[]) => h.analyst(...a),
  fetchWebullFinancials: (...a: any[]) => h.financials(...a),
  // webullAnalystLine is exported by the real module but unused by the adapters.
  webullAnalystLine: () => null,
}));

import {
  webullAnalystAdapter,
  webullFundamentalsAdapter,
} from "@/lib/evidence/adapters/webull";

const CTX: ProviderCallContext = { market: "us", asOf: "2026-07-14T00:00:00.000Z", timeoutMs: 5000 };
const req = (symbol: string): ProviderRequest => ({ intent: "analyst.consensus", symbol, market: "us" });
const fundReq = (symbol: string): ProviderRequest => ({ intent: "fundamentals.reported", symbol, market: "us" });

// ── PROBE_RESULTS-derived golden fixtures (parser OUTPUT, not raw MCP JSON) ────

// AAPL analyst: buckets strong_buy22/buy6/hold17/under_perform1/sell1, number47.
// rating = round((22*100 + 6*80 + 17*50 + 1*20 + 1*0) / 47)
//        = round((2200 + 480 + 850 + 20 + 0) / 47) = round(3550/47) = round(75.53) = 76.
// targetPrice = consensus mean "315.56667"; forecastEps = the reported:false row
// (2026 Q3) est "1.89428" — the forward estimate, never a reported `actual`.
const AAPL_ANALYST: WebullAnalyst = {
  rating: 76,
  ratingLabel: null,
  targetPrice: 315.56667,
  forecastEps: 1.89428,
};

// SPY empty-ok: the tool returned {symbol,category} only, so the real fetcher
// yields a partial object with every signal field null (NOT null itself).
const SPY_ANALYST_EMPTY: WebullAnalyst = {
  rating: null,
  ratingLabel: null,
  targetPrice: null,
  forecastEps: null,
};

// AAPL financials: newest quarter per metric. Ratios are already FRACTIONS
// (net_margin 0.2660, roe 0.3039, roa 0.0788 — verified live). The remaining
// per-share metrics are representative fixtures (only net_margin is asserted).
const AAPL_FINANCIALS: Record<string, number> = {
  net_margin: 0.266,
  roe: 0.3039,
  roa: 0.0788,
  debt_to_assets: 0.29,
  diluted_eps_incl_extra: 2.01,
  naps: 4.53,
  ocf_ps: 1.82,
  cap_surplus_ps: 0.7,
};

beforeEach(() => {
  h.analyst.mockReset();
  h.financials.mockReset();
});

describe("webullAnalystAdapter", () => {
  it("maps AAPL buckets → rating 76, mean target 315.57, forward EPS 1.89428", async () => {
    h.analyst.mockResolvedValue(AAPL_ANALYST);

    const res = await webullAnalystAdapter.fetch(req("AAPL"), CTX);
    expect(res.ok).toBe(true);
    const payload = res.payload as { rating: number; targetPrice: number; forecastEps: number };
    expect(payload.rating).toBe(76);
    expect(payload.targetPrice).toBeCloseTo(315.57, 1);
    expect(payload.forecastEps).toBe(1.89428);

    const canon = webullAnalystAdapter.toCanonical(res);
    const cp = canon.payload as { rating: number | null; targetPrice: number | null; forecastEps: number | null };
    expect(cp.rating).toBe(76);
    expect(cp.targetPrice).toBeCloseTo(315.57, 1);
    // forecastEps is the forward estimate (reported:false est), NOT a past actual.
    expect(cp.forecastEps).toBe(1.89428);
  });

  it("tags forecastEps provenance basis 'forward' and rating/target 'spot'", async () => {
    h.analyst.mockResolvedValue(AAPL_ANALYST);
    const res = await webullAnalystAdapter.fetch(req("AAPL"), CTX);
    const { provenance } = webullAnalystAdapter.toCanonical(res);

    const byField = Object.fromEntries(provenance.map((p) => [p.providerField, p]));
    expect(byField.forecastEps.basis).toBe("forward");
    expect(byField.rating.basis).toBe("spot");
    expect(byField.targetPrice.basis).toBe("spot");
    // per-share vs consensus units are load-bearing too.
    expect(byField.forecastEps.unit).toBe("per_share");
    expect(byField.targetPrice.unit).toBe("currency");
  });

  it("empty-ok (SPY {symbol,category} → all-null) → genuine_no_data", async () => {
    h.analyst.mockResolvedValue(SPY_ANALYST_EMPTY);
    const res = await webullAnalystAdapter.fetch(req("SPY"), CTX);
    expect(res.ok).toBe(false);
    expect(res.unavailableReason).toBe("genuine_no_data");
  });

  it("unknown-symbol error (fetcher returns null) → genuine_no_data", async () => {
    h.analyst.mockResolvedValue(null);
    const res = await webullAnalystAdapter.fetch(req("ZZZQFAKE"), CTX);
    expect(res.ok).toBe(false);
    expect(res.unavailableReason).toBe("genuine_no_data");
  });

  it("validate() rejects a __proto__ pollution key → schema_invalid", () => {
    // JSON.parse creates a real OWN enumerable "__proto__" property (a literal
    // would not) — the exact prototype-pollution vector the guard must catch.
    const polluted = JSON.parse('{"__proto__":1,"rating":76,"targetPrice":315,"forecastEps":1.9}');
    const res = webullAnalystAdapter.validate(polluted);
    expect(res.ok).toBe(false);
    expect(res.unavailableReason).toBe("schema_invalid");
  });

  it("validate() rejects a constructor pollution key → schema_invalid", () => {
    const res = webullAnalystAdapter.validate({ constructor: 1, rating: 76, targetPrice: 315, forecastEps: 1.9 });
    expect(res.ok).toBe(false);
    expect(res.unavailableReason).toBe("schema_invalid");
  });
});

describe("webullFundamentalsAdapter", () => {
  it("keeps net_margin 0.266 as a fraction (no rescale) through fetch + toCanonical", async () => {
    h.financials.mockResolvedValue(AAPL_FINANCIALS);

    const res = await webullFundamentalsAdapter.fetch(fundReq("AAPL"), CTX);
    expect(res.ok).toBe(true);
    expect((res.payload as { netMargin: number }).netMargin).toBe(0.266);

    const canon = webullFundamentalsAdapter.toCanonical(res);
    expect((canon.payload as { netMargin: number }).netMargin).toBe(0.266);
  });

  it("stamps basis 'quarterly' on EVERY field of provenance", async () => {
    h.financials.mockResolvedValue(AAPL_FINANCIALS);
    const res = await webullFundamentalsAdapter.fetch(fundReq("AAPL"), CTX);
    const { provenance } = webullFundamentalsAdapter.toCanonical(res);

    expect(provenance.length).toBe(8);
    expect(provenance.every((p) => p.basis === "quarterly")).toBe(true);
  });

  it("empty-ok / no-data (fetcher returns null) → genuine_no_data", async () => {
    h.financials.mockResolvedValue(null);
    const res = await webullFundamentalsAdapter.fetch(fundReq("SPY"), CTX);
    expect(res.ok).toBe(false);
    expect(res.unavailableReason).toBe("genuine_no_data");
  });

  it("validate() rejects a __proto__ pollution key → schema_invalid", () => {
    const polluted = JSON.parse('{"__proto__":1,"netMargin":0.266}');
    const res = webullFundamentalsAdapter.validate(polluted);
    expect(res.ok).toBe(false);
    expect(res.unavailableReason).toBe("schema_invalid");
  });
});
