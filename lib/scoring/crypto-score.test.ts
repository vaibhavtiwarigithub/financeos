import { describe, expect, it } from "vitest";
import { scoreCryptoShadow } from "./crypto-score";

describe("scoreCryptoShadow", () => {
  const base = { trendScore: 80, structureScore: 70, volatilityScore: 60, spreadPct: 0.1, quoteAgeSeconds: 5, maxSpreadPct: 0.25, maxQuoteAgeSeconds: 15 };

  it("is deterministic and records the score version", () => {
    expect(scoreCryptoShadow(base)).toEqual({ ok: true, score: 71.5, components: { trend: 80, structure: 70, volatility: 60 }, version: "crypto-score-shadow-v1" });
  });

  it("refuses a stale or expensive quote instead of compensating with a higher score", () => {
    expect(scoreCryptoShadow({ ...base, spreadPct: 0.26 })).toMatchObject({ ok: false, reason: "spread_exceeds_policy" });
    expect(scoreCryptoShadow({ ...base, quoteAgeSeconds: 16 })).toMatchObject({ ok: false, reason: "quote_stale" });
  });

  it("refuses missing dimensions", () => {
    expect(scoreCryptoShadow({ ...base, trendScore: null })).toMatchObject({ ok: false, reason: "missing_or_invalid_score_component" });
  });
});
