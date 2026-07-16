import { describe, expect, it } from "vitest";
import { toAdapterQuote, STALE_MS, type FetchOutcome } from "@/lib/india-markets/adapter";

const NOW = Date.parse("2026-07-15T06:00:00.000Z"); // during an India session
const freshMeta = {
  regularMarketPrice: 24000,
  chartPreviousClose: 23800,
  regularMarketTime: Math.floor(NOW / 1000) - 60, // 1 min old
  currency: "INR",
};

describe("toAdapterQuote — India adapter validation core", () => {
  it("success: finite INR quote resolves ok/fresh with rounded changePct", () => {
    const q = toAdapterQuote("^NSEI", { kind: "ok", meta: freshMeta }, NOW);
    expect(q.ok).toBe(true);
    expect(q.reasonCode).toBe("ok");
    expect(q.price).toBe(24000);
    expect(q.changePct).toBeCloseTo(0.84, 2); // (24000-23800)/23800*100
    expect(q.quality).toBe("fresh");
    expect(q.source).toBe("yahoo");
    expect(q.observedAt).not.toBeNull();
  });

  it("partial (no_data): missing payload is excluded, not zero-filled", () => {
    const q = toAdapterQuote("^CNXIT", { kind: "no_data" }, NOW);
    expect(q.ok).toBe(false);
    expect(q.reasonCode).toBe("no_data");
    expect(q.price).toBeNull();
    expect(q.changePct).toBeNull();
  });

  it("throttle (429): flagged throttled, never presented as a quote", () => {
    const q = toAdapterQuote("^BSESN", { kind: "throttled" }, NOW);
    expect(q.ok).toBe(false);
    expect(q.reasonCode).toBe("throttled");
  });

  it("http_error and network_error map to distinct non-ok reasons", () => {
    expect(toAdapterQuote("X", { kind: "http_error", status: 500 }, NOW).reasonCode).toBe("http_error");
    expect(toAdapterQuote("X", { kind: "network_error" }, NOW).reasonCode).toBe("network_error");
  });

  it("stale: an old observation is kept but flagged stale (not dropped)", () => {
    const oldMeta = { ...freshMeta, regularMarketTime: Math.floor((NOW - STALE_MS - 60_000) / 1000) };
    const q = toAdapterQuote("^NSEI", { kind: "ok", meta: oldMeta }, NOW);
    expect(q.ok).toBe(true);
    expect(q.quality).toBe("stale");
  });

  it("bad-currency: a non-INR resolution is rejected", () => {
    const usd = { ...freshMeta, currency: "USD" };
    const q = toAdapterQuote("^NSEI", { kind: "ok", meta: usd }, NOW);
    expect(q.ok).toBe(false);
    expect(q.reasonCode).toBe("bad_currency");
  });

  it("non-finite: NaN/Infinity/zero price or prevClose is rejected", () => {
    const cases: FetchOutcome[] = [
      { kind: "ok", meta: { ...freshMeta, regularMarketPrice: Number.NaN } },
      { kind: "ok", meta: { ...freshMeta, regularMarketPrice: Number.POSITIVE_INFINITY } },
      { kind: "ok", meta: { ...freshMeta, regularMarketPrice: 0 } },
      { kind: "ok", meta: { ...freshMeta, chartPreviousClose: undefined, previousClose: undefined } },
    ];
    for (const c of cases) {
      const q = toAdapterQuote("^NSEI", c, NOW);
      expect(q.ok).toBe(false);
      expect(q.reasonCode).toBe("non_finite");
    }
  });
});
