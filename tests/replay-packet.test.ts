// P1/P2 — packet assembler: knowable-date derivation, as-of filtering, fundamentals
// filing-date freezing + publication-lag assumption, manifest hashing, immutability.

import { describe, it, expect } from "vitest";
import {
  assemblePacket,
  freezeObservationsAsOf,
  DEFAULT_FUNDAMENTAL_LAG_DAYS,
  type RawRecord,
} from "@/lib/replay/packet-assembler";
import type { LabeledObservation } from "@/lib/learning/dataset";

function obs(id: number, ts: string): LabeledObservation {
  return {
    id, ts, market: "us", symbol: "MU",
    analyst_score: 60, fundamental_score: 60, technical_score: 60,
    sentiment_score: 60, macro_score: 60, insider_score: 60,
    direction: "long", entry_eligible: true, score_threshold: 60, availability_mask: null,
    horizon_days: 10, fwd_return: 0.01, benchmark_return: 0,
    benchmark_neutral_return: 0.01, max_adverse_excursion: -0.02, max_favorable_excursion: 0.03,
  };
}

describe("assemblePacket — freeze rules & immutability", () => {
  const raws: RawRecord[] = [
    { itemType: "ohlcv", symbol: "MU", date: "2023-01-05", payload: { close: 58 } },
    { itemType: "ohlcv", symbol: "MU", date: "2023-01-20", payload: { close: 62 } }, // after as-of
    { itemType: "news", symbol: "MU", publishedAt: "2023-01-08T12:00:00Z", payload: { title: "x" } },
    // Fundamental with an explicit filing date <= as-of → included at filing date.
    { itemType: "fundamental", symbol: "MU", filedAt: "2022-12-21", periodEnd: "2022-11-30", payload: { eps: 1.1 } },
    // Fundamental with ONLY a period end → publication lag applied.
    { itemType: "fundamental", symbol: "MU", periodEnd: "2022-12-31", payload: { eps: 0.9 } },
  ];

  it("keeps only records public at as-of and drops future ones", () => {
    const { packet, excluded } = assemblePacket({
      cohort: "semis_memory_2022", symbol: "MU", market: "us", asOf: "2023-01-15", raws,
    });
    // The 2023-01-20 candle is excluded; the period-end-only fundamental (2022-12-31 +
    // 60d = 2023-03-01) is also excluded as not-yet-filed at 2023-01-15.
    const kept = packet.items.map((i) => `${i.itemType}@${i.knowableAt}`);
    expect(kept).toContain("ohlcv@2023-01-05");
    expect(kept).toContain("news@2023-01-08T12:00:00Z");
    expect(kept).toContain("fundamental@2022-12-21");
    expect(kept).not.toContain("ohlcv@2023-01-20");
    expect(excluded.some((e) => e.record.date === "2023-01-20")).toBe(true);
    expect(excluded.some((e) => e.knowableAt === "2023-03-01")).toBe(true);
  });

  it("applies and RECORDS the publication-lag assumption for period-only fundamentals", () => {
    // Push as-of past the lagged date so the period-only fundamental is included.
    const { packet } = assemblePacket({
      cohort: "c", symbol: "MU", market: "us", asOf: "2023-04-01", raws,
    });
    const lagged = packet.items.find((i) => i.knowableAt === "2023-03-01");
    expect(lagged).toBeTruthy();
    expect(packet.publicationLagAssumptions.fundamentalLagDays).toBe(DEFAULT_FUNDAMENTAL_LAG_DAYS);
    expect(String((packet.publicationLagAssumptions.appliedTo as string[])[0])).toContain("2022-12-31");
  });

  it("prefers filing date over fiscal period (no future earnings injection)", () => {
    const { packet } = assemblePacket({
      cohort: "c", symbol: "MU", market: "us", asOf: "2023-01-15", raws,
    });
    const f = packet.items.find((i) => i.itemType === "fundamental");
    // Uses the 2022-12-21 filing date, not the 2022-11-30 period end.
    expect(f?.knowableAt).toBe("2022-12-21");
  });

  it("is immutable (deep-frozen) and reproducible (stable manifest hash)", () => {
    const a = assemblePacket({ cohort: "c", symbol: "MU", market: "us", asOf: "2023-01-15", raws });
    const b = assemblePacket({ cohort: "c", symbol: "MU", market: "us", asOf: "2023-01-15", raws });
    expect(a.packet.manifestHash).toBe(b.packet.manifestHash);
    expect(Object.isFrozen(a.packet)).toBe(true);
    expect(Object.isFrozen(a.packet.items)).toBe(true);
    expect(() => {
      // @ts-expect-error — testing runtime immutability
      a.packet.items.push({});
    }).toThrow();
  });
});

describe("freezeObservationsAsOf — label maturation is the sealing key", () => {
  const timeline = [
    obs(1, "2023-01-01T00:00:00Z"), // label matures 2023-01-11
    obs(2, "2023-01-20T00:00:00Z"), // label matures 2023-01-30
    obs(3, "2023-02-15T00:00:00Z"), // label matures 2023-02-25
  ];

  it("exposes only observations whose label matured by as-of", () => {
    expect(freezeObservationsAsOf(timeline, "2023-01-15", 10).map((s) => s.observation.id)).toEqual([1]);
    expect(freezeObservationsAsOf(timeline, "2023-02-01", 10).map((s) => s.observation.id)).toEqual([1, 2]);
    expect(freezeObservationsAsOf(timeline, "2023-03-01", 10).map((s) => s.observation.id)).toEqual([1, 2, 3]);
  });

  it("stamps knowableAt at ts + horizonDays", () => {
    const [s] = freezeObservationsAsOf([timeline[0]], "2023-01-15", 10);
    expect(s.knowableAt).toBe("2023-01-11");
  });
});
