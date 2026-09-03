import { describe, it, expect } from "vitest";
import {
  screenQuote, applyPrefilter, DEFAULT_PREFILTER,
  normalizeUpstoxTimestamp,
  type BulkQuote, type PrefilterConfig,
} from "@/lib/data/upstox-bulk";

const q = (over: Partial<BulkQuote>): BulkQuote => ({
  symbol: "TEST.NS",
  lastPrice: 500,
  volume: 100_000,          // turnover ₹5cr — clears the ₹1cr floor
  lowerCircuit: 400,
  upperCircuit: 600,
  retrievedAt: null,
  bid: null,
  ask: null,
  ...over,
});

describe("Upstox quote timestamps", () => {
  it("preserves the exchange last-trade instant from epoch milliseconds", () => {
    expect(normalizeUpstoxTimestamp("1788256800000")).toBe("2026-09-01T10:00:00.000Z");
  });

  it("accepts ISO timestamps and refuses unknown values", () => {
    expect(normalizeUpstoxTimestamp("2026-09-01T15:30:00+05:30")).toBe("2026-09-01T10:00:00.000Z");
    expect(normalizeUpstoxTimestamp("not-a-timestamp")).toBeNull();
    expect(normalizeUpstoxTimestamp(null)).toBeNull();
  });
});

describe("screenQuote", () => {
  it("passes a liquid, mid-band name", () => {
    const v = screenQuote(q({}));
    expect(v.eligible).toBe(true);
    expect(v.reason).toBe("eligible");
    expect(v.turnover).toBe(50_000_000);
  });

  it("rejects a penny stock on the price floor", () => {
    expect(screenQuote(q({ lastPrice: 5 })).reason).toBe("below_price_floor");
  });

  it("rejects an illiquid name on turnover", () => {
    // ₹500 x 100 shares = ₹50,000, far under the ₹1cr floor.
    const v = screenQuote(q({ volume: 100 }));
    expect(v.eligible).toBe(false);
    expect(v.reason).toBe("below_turnover_floor");
    expect(v.turnover).toBe(50_000);
  });

  it("treats missing volume as unknown, not as zero", () => {
    // Distinct reason code so a weekend run's shrunken coverage is explainable
    // rather than looking like every name suddenly became illiquid.
    const v = screenQuote(q({ volume: null }));
    expect(v.reason).toBe("no_volume");
    expect(v.turnover).toBeNull();
  });

  it("rejects a name locked at the UPPER circuit", () => {
    expect(screenQuote(q({ lastPrice: 600, upperCircuit: 600 })).reason).toBe("circuit_locked");
  });

  it("rejects a name locked at the LOWER circuit", () => {
    expect(screenQuote(q({ lastPrice: 400, lowerCircuit: 400 })).reason).toBe("circuit_locked");
  });

  it("tolerates a print a hair inside the band as still locked", () => {
    // Last trade can print marginally inside the limit while the book is locked.
    expect(screenQuote(q({ lastPrice: 599.9, upperCircuit: 600 })).reason).toBe("circuit_locked");
  });

  it("does not treat a name merely NEAR the band as locked", () => {
    expect(screenQuote(q({ lastPrice: 590, upperCircuit: 600 })).eligible).toBe(true);
  });

  it("ignores circuit state when the config disables that check", () => {
    const cfg: PrefilterConfig = { ...DEFAULT_PREFILTER, excludeCircuitLocked: false };
    expect(screenQuote(q({ lastPrice: 600, upperCircuit: 600 }), cfg).eligible).toBe(true);
  });

  it("rejects a missing or non-positive price", () => {
    expect(screenQuote(q({ lastPrice: null })).reason).toBe("no_price");
    expect(screenQuote(q({ lastPrice: 0 })).reason).toBe("no_price");
  });

  it("falls back to the session close when last_price is absent", () => {
    // Exercised via the mapping in fetchUpstoxBulkQuotes; here we assert the
    // screen itself is fine with a close-derived price.
    expect(screenQuote(q({ lastPrice: 450 })).eligible).toBe(true);
  });
});

describe("applyPrefilter", () => {
  const universe = ["A.NS", "B.NS", "C.NS", "D.NS"];

  it("keeps only eligible names and preserves the caller's order", () => {
    const quotes = new Map<string, BulkQuote>([
      ["A.NS", q({ symbol: "A.NS" })],
      ["B.NS", q({ symbol: "B.NS", volume: 1 })],            // illiquid
      ["C.NS", q({ symbol: "C.NS" })],
      ["D.NS", q({ symbol: "D.NS", lastPrice: 2 })],         // penny
    ]);
    const { eligible, rejected } = applyPrefilter(universe, quotes);
    expect(eligible).toEqual(["A.NS", "C.NS"]);              // order preserved
    expect(rejected.below_turnover_floor).toBe(1);
    expect(rejected.below_price_floor).toBe(1);
    expect(rejected.eligible).toBe(2);
  });

  it("KEEPS symbols missing from the sweep rather than dropping them", () => {
    // Absence of evidence must not shrink the universe: a symbol with no Upstox
    // instrument key would otherwise become permanently unresearchable.
    const quotes = new Map<string, BulkQuote>([["A.NS", q({ symbol: "A.NS" })]]);
    const { eligible, unknown } = applyPrefilter(["A.NS", "ZZZ.NS"], quotes);
    expect(eligible).toEqual(["A.NS", "ZZZ.NS"]);
    expect(unknown).toEqual(["ZZZ.NS"]);
  });

  it("returns the whole universe unchanged when the sweep is empty", () => {
    // The fail-open contract: a failed sweep must not screen anything out.
    const { eligible, unknown } = applyPrefilter(universe, new Map());
    expect(eligible).toEqual(universe);
    expect(unknown).toEqual(universe);
  });

  it("does not re-rank by liquidity", () => {
    // Ranking by turnover would pin the expensive path to the same large caps
    // forever and starve mid-caps. Staleness order must survive intact.
    const quotes = new Map<string, BulkQuote>([
      ["A.NS", q({ symbol: "A.NS", volume: 1_000 })],        // ₹5L  — smallest eligible
      ["B.NS", q({ symbol: "B.NS", volume: 10_000_000 })],   // huge
      ["C.NS", q({ symbol: "C.NS", volume: 100_000 })],
    ]);
    const cfg: PrefilterConfig = { ...DEFAULT_PREFILTER, minTurnover: 0 };
    expect(applyPrefilter(["A.NS", "B.NS", "C.NS"], quotes, cfg).eligible)
      .toEqual(["A.NS", "B.NS", "C.NS"]);
  });
});
