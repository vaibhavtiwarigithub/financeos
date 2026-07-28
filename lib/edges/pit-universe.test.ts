import { describe, it, expect, afterEach } from "vitest";
import {
  isEligibleTicker,
  rankByLiquidity,
  universeFingerprint,
  liquidityAvailableFor,
  resolvePitUniverse,
  PIT_POLICY_VERSION,
} from "./pit-universe";

describe("isEligibleTicker", () => {
  const base = { ticker: "AAPL", type: "CS", primary_exchange: "XNAS" };

  it("accepts exchange-listed common stock", () => {
    expect(isEligibleTicker(base)).toBe(true);
  });

  it("rejects the instrument classes the curated list never held", () => {
    // The PIT set replaces lib/edges/universe.ts, which is individual stocks
    // only. Widening the population would change what IC even measures.
    expect(isEligibleTicker({ ...base, type: "ETF" })).toBe(false);   // AAAU etc.
    expect(isEligibleTicker({ ...base, type: "ADRC" })).toBe(false);
    expect(isEligibleTicker({ ...base, type: "GDR" })).toBe(false);
    expect(isEligibleTicker({ ...base, primary_exchange: "OTC Link" })).toBe(false);
    expect(isEligibleTicker({ ...base, primary_exchange: "" })).toBe(false);
    expect(isEligibleTicker({ ticker: "AAB.WS", type: "CS", primary_exchange: "XASE" })).toBe(false);
  });
});

describe("rankByLiquidity", () => {
  it("takes the top N by dollar volume", () => {
    const r = rankByLiquidity(
      [
        { symbol: "LOW", advValue: 10 },
        { symbol: "HIGH", advValue: 1000 },
        { symbol: "MID", advValue: 100 },
      ],
      2,
    );
    expect(r.map((m) => m.symbol)).toEqual(["HIGH", "MID"]);
    expect(r.map((m) => m.advRank)).toEqual([1, 2]);
  });

  it("breaks ties deterministically so the fingerprint is stable", () => {
    const rows = [
      { symbol: "BBB", advValue: 50 },
      { symbol: "AAA", advValue: 50 },
      { symbol: "CCC", advValue: 50 },
    ];
    expect(rankByLiquidity(rows, 3).map((m) => m.symbol)).toEqual(["AAA", "BBB", "CCC"]);
    // Same set, different input order — must produce the same ranking.
    expect(rankByLiquidity([...rows].reverse(), 3).map((m) => m.symbol)).toEqual(["AAA", "BBB", "CCC"]);
  });

  it("drops zero/non-finite volume rather than ranking an untraded name", () => {
    const r = rankByLiquidity(
      [{ symbol: "DEAD", advValue: 0 }, { symbol: "NAN", advValue: NaN }, { symbol: "OK", advValue: 5 }],
      10,
    );
    expect(r.map((m) => m.symbol)).toEqual(["OK"]);
  });

  it("carries delistedAt through — the survivorship fix is the point", () => {
    const r = rankByLiquidity([{ symbol: "AABA", advValue: 99, delistedAt: "2019-10-07" }], 1);
    expect(r[0].delistedAt).toBe("2019-10-07");
  });
});

describe("universeFingerprint", () => {
  it("is order-independent but content-sensitive", () => {
    const a = universeFingerprint("us", "2026-01-02", "v1", ["MSFT", "AAPL"]);
    const b = universeFingerprint("us", "2026-01-02", "v1", ["AAPL", "MSFT"]);
    expect(a).toBe(b);
    expect(universeFingerprint("us", "2026-01-02", "v1", ["AAPL"])).not.toBe(a);
  });

  it("separates market, date and policy version", () => {
    const syms = ["AAPL"];
    const base = universeFingerprint("us", "2026-01-02", "v1", syms);
    expect(universeFingerprint("india", "2026-01-02", "v1", syms)).not.toBe(base);
    expect(universeFingerprint("us", "2026-01-03", "v1", syms)).not.toBe(base);
    expect(universeFingerprint("us", "2026-01-02", "v2", syms)).not.toBe(base);
  });
});

describe("liquidityAvailableFor", () => {
  const today = new Date("2026-07-28T00:00:00Z");

  it("matches the measured ~2-year aggregate entitlement", () => {
    // Verified against the live provider 2026-07-28.
    expect(liquidityAvailableFor("2026-07-24", today)).toBe(true);   // OK, 12410 rows
    expect(liquidityAvailableFor("2024-10-15", today)).toBe(true);   // OK, 10704 rows
    expect(liquidityAvailableFor("2023-06-30", today)).toBe(false);  // NOT_AUTHORIZED
  });

  it("refuses future dates and malformed input", () => {
    expect(liquidityAvailableFor("2026-08-01", today)).toBe(false);
    expect(liquidityAvailableFor("not-a-date", today)).toBe(false);
  });
});

describe("resolvePitUniverse — fails closed", () => {
  const today = new Date("2026-07-28T00:00:00Z");

  it("refuses India rather than falling back to the curated list", async () => {
    const r = await resolvePitUniverse({
      market: "india", asOf: "2026-07-24", size: 200, minSymbols: 100, apiKey: "k", today,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("universe_not_point_in_time");
  });

  it("refuses a date outside the liquidity entitlement without calling the provider", async () => {
    const r = await resolvePitUniverse({
      market: "us", asOf: "2023-06-30", size: 200, minSymbols: 100, apiKey: "k", today,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("liquidity_not_available_for_date");
  });

  it("refuses when the provider is unconfigured", async () => {
    const r = await resolvePitUniverse({
      market: "us", asOf: "2026-07-24", size: 200, minSymbols: 100, apiKey: "", today,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("provider_unconfigured");
  });

  it("pins the policy version — snapshots are keyed by it", () => {
    expect(PIT_POLICY_VERSION).toBe("us_pit_v1");
  });
});

describe("fetchPitMembership completeness", () => {
  const orig = globalThis.fetch;
  afterEach(() => { globalThis.fetch = orig; });

  const page = (results: unknown[], next?: string) =>
    ({ ok: true, json: async () => ({ status: "OK", results, ...(next ? { next_url: next } : {}) }) }) as any;

  it("reports complete when the walk reaches the last page", async () => {
    const { fetchPitMembership } = await import("./pit-universe");
    let n = 0;
    globalThis.fetch = (async () => (++n === 1 ? page([{ ticker: "A" }], "https://x/p2") : page([{ ticker: "B" }]))) as any;
    const r = await fetchPitMembership("2026-07-24", "k");
    expect(r.complete).toBe(true);
    expect(r.tickers.map((t) => t.ticker)).toEqual(["A", "B"]);
  });

  it("reports INCOMPLETE when a page fails mid-walk (the 429 case)", async () => {
    // Observed for real on 2026-07-28: the membership set is ~10k tickers, so a
    // full walk is ~10 requests and the plan rate-limits. Before this flag, the
    // loop broke and a partial universe was ranked as if it were the whole one.
    const { fetchPitMembership } = await import("./pit-universe");
    let n = 0;
    globalThis.fetch = (async () =>
      ++n === 1 ? page([{ ticker: "A" }], "https://x/p2") : ({ ok: false, status: 429 } as any)) as any;
    const r = await fetchPitMembership("2026-07-24", "k");
    expect(r.complete).toBe(false);
    expect(r.tickers.map((t) => t.ticker)).toEqual(["A"]); // partial, and known to be
  });

  it("resolvePitUniverse refuses a truncated walk instead of ranking it", async () => {
    const { resolvePitUniverse } = await import("./pit-universe");
    let n = 0;
    globalThis.fetch = (async () =>
      ++n === 1 ? page([{ ticker: "A", type: "CS", primary_exchange: "XNAS" }], "https://x/p2")
                : ({ ok: false, status: 429 } as any)) as any;
    const r = await resolvePitUniverse({
      market: "us", asOf: "2026-07-24", size: 200, minSymbols: 1,
      apiKey: "k", today: new Date("2026-07-28T00:00:00Z"),
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("membership_incomplete");
  });
});
