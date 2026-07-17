import { describe, it, expect } from "vitest";
import {
  buildReturnObservation,
  buildDailyReturnRows,
  captureReturnObservation,
  fingerprint,
  measureBeta,
  pitFilter,
  dailyReturns,
  stddev,
  alignReturns,
  MIN_BETA_OVERLAP,
  MIN_VOL_OBSERVATIONS,
  type ReturnObservationRow,
} from "@/lib/data/return-observations";
import type { Candle } from "@/lib/data/technicals";

// ── fixtures ─────────────────────────────────────────────────────────────────

/** Deterministic pseudo-random in [0,1) — no Math.random, tests must be reproducible. */
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

/** Consecutive weekday-ish session dates starting at 2026-01-01, as YYYY-MM-DD. */
function sessionDates(n: number, start = Date.UTC(2026, 0, 1)): string[] {
  return Array.from({ length: n }, (_, i) => new Date(start + i * 86400000).toISOString().slice(0, 10));
}

function candlesFrom(closes: number[], dates = sessionDates(closes.length)): Candle[] {
  return closes.map((c, i) => ({ date: dates[i], open: c, high: c, low: c, close: c, volume: 100 }));
}

function bars(closes: number[], dates = sessionDates(closes.length)) {
  return closes.map((c, i) => ({ date: dates[i], close: c }));
}

/** A benchmark walk and a symbol walk with `beta` loading on it, over n sessions. */
function correlatedSeries(n: number, beta: number, seed = 7) {
  const r = rng(seed);
  const bench: number[] = [100];
  const sym: number[] = [50];
  for (let i = 1; i < n; i++) {
    const br = (r() - 0.5) * 0.02;
    const idio = (r() - 0.5) * 0.004;
    bench.push(bench[i - 1] * (1 + br));
    sym.push(sym[i - 1] * (1 + beta * br + idio));
  }
  const dates = sessionDates(n);
  return { benchmark: bars(bench, dates), candles: candlesFrom(sym, dates) };
}

const NOW = new Date("2026-07-16T20:00:00.000Z");

// ── point-in-time correctness ────────────────────────────────────────────────

describe("point-in-time correctness", () => {
  it("drops bars dated after available_at — a future session is not storable", () => {
    const dates = ["2026-07-13", "2026-07-14", "2026-07-15", "2026-07-16", "2026-07-17", "2026-07-20"];
    const kept = pitFilter(bars([10, 11, 12, 13, 99, 98], dates), NOW);
    expect(kept.map((b) => b.date)).toEqual(["2026-07-13", "2026-07-14", "2026-07-15", "2026-07-16"]);
  });

  it("window_end never exceeds available_at's date even when the provider returns future bars", () => {
    const dates = ["2026-07-14", "2026-07-15", "2026-07-16", "2026-07-17"];
    const obs = buildReturnObservation({
      symbol: "AAPL",
      market: "us",
      candles: candlesFrom([10, 11, 12, 13], dates),
      source: "massive",
      benchmark: null,
      now: NOW,
    })!;
    expect(obs.window_end).toBe("2026-07-16");
    expect(obs.as_of).toBe("2026-07-16");
    expect(obs.as_of <= obs.available_at.slice(0, 10)).toBe(true);
  });

  it("a lookahead bar cannot influence the measured vol", () => {
    const dates = sessionDates(40, Date.UTC(2026, 5, 7)); // 2026-06-07 .. 2026-07-16
    const r = rng(3);
    const closes = [100];
    for (let i = 1; i < 40; i++) closes.push(closes[i - 1] * (1 + (r() - 0.5) * 0.02));

    const clean = buildReturnObservation({
      symbol: "X", market: "us", candles: candlesFrom(closes, dates), source: "massive", now: NOW,
    })!;
    // Same series + a violent future bar the provider leaked in.
    const withFuture = buildReturnObservation({
      symbol: "X", market: "us",
      candles: candlesFrom([...closes, closes[39] * 1.5], [...dates, "2026-07-17"]),
      source: "massive", now: NOW,
    })!;

    expect(withFuture.daily_vol).toBe(clean.daily_vol);
    expect(withFuture.observation_count).toBe(clean.observation_count);
    expect(withFuture.input_fingerprint).toBe(clean.input_fingerprint);
  });

  it("applies the same PIT cutoff to the benchmark series", () => {
    const n = MIN_BETA_OVERLAP + 30;
    const { benchmark, candles } = correlatedSeries(n, 1.2);
    // Push everything into the past, then append a future benchmark bar.
    const obs = buildReturnObservation({
      symbol: "X", market: "us", candles, source: "massive",
      benchmark: [...benchmark, { date: "2099-01-01", close: 1 }],
      now: new Date(`${benchmark[n - 1].date}T23:00:00.000Z`),
    })!;
    const clean = buildReturnObservation({
      symbol: "X", market: "us", candles, source: "massive", benchmark,
      now: new Date(`${benchmark[n - 1].date}T23:00:00.000Z`),
    })!;
    expect(obs.benchmark_beta).toBe(clean.benchmark_beta);
    expect(obs.benchmark_overlap_sessions).toBe(clean.benchmark_overlap_sessions);
  });

  it("available_at is the capture instant and is never before as_of", () => {
    const obs = buildReturnObservation({
      symbol: "X", market: "us", candles: candlesFrom([1, 2, 3]), source: "massive", now: NOW,
    })!;
    expect(obs.available_at).toBe(NOW.toISOString());
    expect(new Date(obs.available_at).getTime()).toBeGreaterThanOrEqual(new Date(obs.as_of).getTime());
  });
});

// ── null beta when unmeasurable (never a proxy) ──────────────────────────────

describe("beta is null unless genuinely measurable", () => {
  it("returns null with insufficient_overlap below the 60-session floor", () => {
    const n = MIN_BETA_OVERLAP - 1;
    const { benchmark, candles } = correlatedSeries(n, 1.3);
    const obs = buildReturnObservation({
      symbol: "X", market: "us", candles, benchmark, source: "massive",
      now: new Date(`${benchmark[n - 1].date}T23:00:00.000Z`),
    })!;
    expect(obs.benchmark_beta).toBeNull();
    expect(obs.beta_unmeasurable_reason).toBe("insufficient_overlap");
    expect(obs.benchmark_overlap_sessions).toBeLessThan(MIN_BETA_OVERLAP);
  });

  it("returns null with benchmark_series_unavailable when no benchmark is supplied", () => {
    const obs = buildReturnObservation({
      symbol: "X", market: "us", candles: candlesFrom([1, 2, 3, 4]), benchmark: null, source: "massive", now: NOW,
    })!;
    expect(obs.benchmark_beta).toBeNull();
    expect(obs.beta_unmeasurable_reason).toBe("benchmark_series_unavailable");
    // The benchmark it WOULD be measured against is still recorded.
    expect(obs.benchmark_symbol).toBe("SPY");
  });

  it("returns null with benchmark_zero_variance for a flat benchmark", () => {
    const n = MIN_BETA_OVERLAP + 20;
    const dates = sessionDates(n);
    const r = rng(11);
    const sym = [50];
    for (let i = 1; i < n; i++) sym.push(sym[i - 1] * (1 + (r() - 0.5) * 0.02));
    const obs = buildReturnObservation({
      symbol: "X", market: "us", candles: candlesFrom(sym, dates),
      benchmark: bars(new Array(n).fill(100), dates), source: "massive",
      now: new Date(`${dates[n - 1]}T23:00:00.000Z`),
    })!;
    expect(obs.benchmark_beta).toBeNull();
    expect(obs.beta_unmeasurable_reason).toBe("benchmark_zero_variance");
  });

  it("beta and its absence-reason are mutually exclusive (mirrors the DB check)", () => {
    const n = MIN_BETA_OVERLAP + 40;
    const { benchmark, candles } = correlatedSeries(n, 1.4);
    const now = new Date(`${benchmark[n - 1].date}T23:00:00.000Z`);
    const measured = buildReturnObservation({ symbol: "X", market: "us", candles, benchmark, source: "massive", now })!;
    const unmeasured = buildReturnObservation({ symbol: "X", market: "us", candles, benchmark: null, source: "massive", now })!;

    for (const obs of [measured, unmeasured] as ReturnObservationRow[]) {
      const hasBeta = obs.benchmark_beta !== null;
      const hasReason = obs.beta_unmeasurable_reason !== null;
      expect(hasBeta).toBe(!hasReason);
    }
    expect(measured.benchmark_beta).not.toBeNull();
  });

  it("recovers a known beta when there IS enough overlap", () => {
    const n = 200;
    const { benchmark, candles } = correlatedSeries(n, 1.5);
    const obs = buildReturnObservation({
      symbol: "X", market: "us", candles, benchmark, source: "massive",
      now: new Date(`${benchmark[n - 1].date}T23:00:00.000Z`),
    })!;
    expect(obs.benchmark_beta).toBeGreaterThan(1.3);
    expect(obs.benchmark_beta).toBeLessThan(1.7);
    expect(obs.beta_unmeasurable_reason).toBeNull();
    expect(obs.benchmark_overlap_sessions).toBeGreaterThanOrEqual(MIN_BETA_OVERLAP);
  });

  it("measureBeta only counts SHARED sessions — non-overlapping dates never inflate overlap", () => {
    const a = dailyReturns(bars([1, 2, 3, 4], ["2026-01-01", "2026-01-02", "2026-01-03", "2026-01-04"]));
    const b = dailyReturns(bars([1, 2, 3, 4], ["2026-02-01", "2026-02-02", "2026-02-03", "2026-02-04"]));
    const res = measureBeta(a, b, 1);
    expect(res.overlap).toBe(0);
    expect(res.beta).toBeNull();
    expect(res.reason).toBe("insufficient_overlap");
  });

  it("uses each market's OWN benchmark and never cross-sums", () => {
    const us = buildReturnObservation({ symbol: "AAPL", market: "us", candles: candlesFrom([1, 2, 3]), now: NOW })!;
    const india = buildReturnObservation({ symbol: "INFY.NS", market: "india", candles: candlesFrom([1, 2, 3]), now: NOW })!;
    expect(us.benchmark_symbol).toBe("SPY");
    expect(india.benchmark_symbol).toBe("^NSEI");
    expect(us.market).toBe("us");
    expect(india.market).toBe("india");
  });
});

// ── volatility honesty ───────────────────────────────────────────────────────

describe("daily vol", () => {
  it("is null below the minimum observation count rather than a thin guess", () => {
    const obs = buildReturnObservation({
      symbol: "X", market: "us", candles: candlesFrom([10, 11, 12, 13, 14]), source: "massive", now: NOW,
    })!;
    expect(obs.observation_count).toBeLessThan(MIN_VOL_OBSERVATIONS);
    expect(obs.daily_vol).toBeNull();
  });

  it("is measured once there are enough returns", () => {
    const n = 60;
    const dates = sessionDates(n, Date.UTC(2026, 4, 1));
    const r = rng(5);
    const closes = [100];
    for (let i = 1; i < n; i++) closes.push(closes[i - 1] * (1 + (r() - 0.5) * 0.02));
    const obs = buildReturnObservation({
      symbol: "X", market: "us", candles: candlesFrom(closes, dates), source: "massive", now: NOW,
    })!;
    expect(obs.daily_vol).toBeGreaterThan(0);
    expect(obs.observation_count).toBe(n - 1);
  });

  it("stddev is the sample (n-1) stddev and null below 2 points", () => {
    expect(stddev([1])).toBeNull();
    expect(stddev([2, 4])).toBeCloseTo(Math.sqrt(2), 10);
  });

  it("alignReturns inner-joins on dates", () => {
    const a = [{ date: "d1", ret: 0.1 }, { date: "d2", ret: 0.2 }, { date: "d3", ret: 0.3 }];
    const b = [{ date: "d2", ret: 0.9 }, { date: "d3", ret: 0.8 }];
    const out = alignReturns(a, b);
    expect(out.dates).toEqual(["d2", "d3"]);
    expect(out.a).toEqual([0.2, 0.3]);
    expect(out.b).toEqual([0.9, 0.8]);
  });
});

// ── fingerprint stability ────────────────────────────────────────────────────

describe("input fingerprint", () => {
  it("is stable across rebuilds of identical inputs and independent of the clock", () => {
    const c = candlesFrom([10, 11, 12, 13, 14]);
    const a = buildReturnObservation({ symbol: "X", market: "us", candles: c, source: "massive", now: NOW })!;
    const b = buildReturnObservation({
      symbol: "X", market: "us", candles: c, source: "massive",
      now: new Date(NOW.getTime() + 6 * 3600_000), // later same UTC day
    })!;
    expect(a.input_fingerprint).toBe(b.input_fingerprint);
  });

  it("is invariant to the provider's bar ORDER (newest-first vs oldest-first)", () => {
    const c = candlesFrom([10, 11, 12, 13, 14]);
    const a = buildReturnObservation({ symbol: "X", market: "us", candles: c, source: "massive", now: NOW })!;
    const b = buildReturnObservation({ symbol: "X", market: "us", candles: [...c].reverse(), source: "massive", now: NOW })!;
    expect(a.input_fingerprint).toBe(b.input_fingerprint);
  });

  it("changes when any input changes — close, symbol, market, or source", () => {
    const base = { symbol: "X", market: "us" as const, candles: candlesFrom([10, 11, 12, 13, 14]), source: "massive", now: NOW };
    const f0 = buildReturnObservation(base)!.input_fingerprint;
    expect(buildReturnObservation({ ...base, candles: candlesFrom([10, 11, 12, 13, 14.5]) })!.input_fingerprint).not.toBe(f0);
    expect(buildReturnObservation({ ...base, symbol: "Y" })!.input_fingerprint).not.toBe(f0);
    expect(buildReturnObservation({ ...base, market: "india" })!.input_fingerprint).not.toBe(f0);
    expect(buildReturnObservation({ ...base, source: "eodhd" })!.input_fingerprint).not.toBe(f0);
  });

  it("changes when a NEW session arrives (so tomorrow's run appends)", () => {
    const today = candlesFrom([10, 11, 12, 13, 14]);
    const tomorrow = candlesFrom([10, 11, 12, 13, 14, 15]);
    const a = buildReturnObservation({ symbol: "X", market: "us", candles: today, source: "massive", now: NOW })!;
    const b = buildReturnObservation({
      symbol: "X", market: "us", candles: tomorrow, source: "massive",
      now: new Date("2026-07-17T20:00:00.000Z"),
    })!;
    expect(a.input_fingerprint).not.toBe(b.input_fingerprint);
  });

  it("fingerprint() is a pure function of its basis", () => {
    const arg = { symbol: "X", market: "us", source: "massive", benchmarkSymbol: "SPY", bars: bars([1, 2, 3]), benchmarkOverlap: 0 };
    expect(fingerprint(arg)).toBe(fingerprint({ ...arg, bars: bars([1, 2, 3]) }));
  });
});

// ── build/capture contract ───────────────────────────────────────────────────

describe("build + capture", () => {
  it("returns null when there is nothing honest to record", () => {
    expect(buildReturnObservation({ symbol: "X", market: "us", candles: [], now: NOW })).toBeNull();
    expect(buildReturnObservation({ symbol: "X", market: "us", candles: candlesFrom([10]), now: NOW })).toBeNull();
    // All bars in the future → nothing was knowable at available_at.
    expect(buildReturnObservation({
      symbol: "X", market: "us", candles: candlesFrom([10, 11], ["2099-01-01", "2099-01-02"]), now: NOW,
    })).toBeNull();
  });

  it("appends exactly one row via the injected client", async () => {
    const inserted: Record<string, unknown>[] = [];
    const daily: Record<string, unknown>[] = [];
    const fake = { from: (table: string) => ({
      insert: async (row: Record<string, unknown>) => { inserted.push(row); return {}; },
      upsert: async (rows: Record<string, unknown>[]) => { daily.push(...rows); return {}; },
    }) };
    const row = await captureReturnObservation(fake, {
      symbol: "X", market: "us", candles: candlesFrom([10, 11, 12]), source: "massive", now: NOW,
    });
    expect(row).not.toBeNull();
    expect(inserted).toHaveLength(1);
    expect(inserted[0]).toMatchObject({ symbol: "X", market: "us" });
    expect(daily).toHaveLength(2);
    expect(daily[0]).toMatchObject({ symbol: "X", market: "us", price_basis: "adjusted_close" });
  });

  it("freezes one point-in-time row per session and preserves raw-vs-adjusted basis", () => {
    const rows = buildDailyReturnRows({
      symbol: "infy.ns",
      market: "india",
      candles: candlesFrom([100, 110, 121]),
      source: "upstox",
      now: NOW,
    });
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      symbol: "INFY.NS",
      previous_session_date: "2026-01-01",
      session_date: "2026-01-02",
      simple_return: 0.1,
      price_basis: "raw_close",
    });
    expect(rows[0].input_fingerprint).not.toBe(rows[1].input_fingerprint);
  });

  it("is FAIL-OPEN — a write error or a throwing client never propagates", async () => {
    const erroring = { from: () => ({ insert: async () => ({ error: { message: "relation does not exist" } }) }) };
    await expect(captureReturnObservation(erroring, {
      symbol: "X", market: "us", candles: candlesFrom([10, 11, 12]), now: NOW,
    })).resolves.toBeNull();

    const throwing = { from: () => { throw new Error("boom"); } } as never;
    await expect(captureReturnObservation(throwing, {
      symbol: "X", market: "us", candles: candlesFrom([10, 11, 12]), now: NOW,
    })).resolves.toBeNull();
  });

  it("is deterministic — no LLM, no randomness: same inputs, byte-identical row", () => {
    const args = { symbol: "X", market: "us" as const, candles: candlesFrom([10, 11, 12, 13]), source: "massive", now: NOW };
    expect(buildReturnObservation(args)).toEqual(buildReturnObservation(args));
  });
});
