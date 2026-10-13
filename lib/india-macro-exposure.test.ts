import { describe, expect, it } from "vitest";
import { MIN_EXPOSURE_OBS, computeExposure, invert, ols, type FactorLevels, type SessionReturn } from "@/lib/india-macro-exposure";

// Deterministic pseudo-random so the test is stable.
function rng(seed: number) { let s = seed; return () => ((s = (s * 1664525 + 1013904223) % 4294967296) / 4294967296 - 0.5); }

function build(n: number, truth: { market: number; usdinr: number; brent: number; vix: number }, noise = 0.001) {
  const r = rng(7);
  const levels: FactorLevels = { market: new Map(), usdinr: new Map(), brent: new Map(), vix: new Map() };
  const returns: SessionReturn[] = [];
  const lv = { market: 100, usdinr: 80, brent: 70, vix: 15 };
  const dateOf = (i: number) => new Date(Date.UTC(2025, 0, 1 + i)).toISOString().slice(0, 10);
  for (const f of Object.keys(lv) as (keyof typeof lv)[]) levels[f].set(dateOf(0), lv[f]);
  for (let i = 1; i <= n; i++) {
    const ch = { market: r() * 0.02, usdinr: r() * 0.01, brent: r() * 0.03, vix: r() * 0.06 };
    for (const f of Object.keys(lv) as (keyof typeof lv)[]) { lv[f] *= 1 + ch[f]; levels[f].set(dateOf(i), lv[f]); }
    const ret = truth.market * ch.market + truth.usdinr * ch.usdinr + truth.brent * ch.brent + truth.vix * ch.vix + r() * noise;
    returns.push({ session_date: dateOf(i), previous_session_date: dateOf(i - 1), simple_return: ret });
  }
  return { levels, returns };
}

describe("india macro exposure", () => {
  it("inverts a matrix and rejects a singular one", () => {
    const inv = invert([[2, 0], [0, 4]])!;
    expect(inv[0][0]).toBeCloseTo(0.5);
    expect(inv[1][1]).toBeCloseTo(0.25);
    expect(invert([[1, 2], [2, 4]])).toBeNull();
  });
  it("OLS recovers known coefficients and a high R2 on near-noiseless data", () => {
    const x = Array.from({ length: 50 }, (_, i) => [i, (i * 7) % 11]);
    const y = x.map(([a, b]) => 3 + 2 * a - 0.5 * b);
    const fit = ols(y, x)!;
    expect(fit.coef[0]).toBeCloseTo(3, 6);
    expect(fit.coef[1]).toBeCloseTo(2, 6);
    expect(fit.coef[2]).toBeCloseTo(-0.5, 6);
    expect(fit.r2).toBeCloseTo(1, 6);
  });
  it("recovers factor betas from synthetic returns and flags only the significant ones", () => {
    const { levels, returns } = build(300, { market: 1.1, usdinr: 0.8, brent: 0, vix: 0 });
    const res = computeExposure(returns, levels);
    expect(res.ok).toBe(true);
    expect(res.betas!.market).toBeGreaterThan(0.9);
    expect(res.betas!.market).toBeLessThan(1.3);
    expect(res.betas!.usdinr).toBeGreaterThan(0.5);
    expect(res.significant).toContain("market");
    expect(res.significant).toContain("usdinr");
    expect(res.significant).not.toContain("brent");
  });
  it("refuses a short history instead of fitting noise", () => {
    const { levels, returns } = build(MIN_EXPOSURE_OBS - 20, { market: 1, usdinr: 0, brent: 0, vix: 0 });
    expect(computeExposure(returns, levels)).toMatchObject({ ok: false, reason: "insufficient_observations" });
  });
  it("refuses when factor levels are missing for too many sessions", () => {
    const { levels, returns } = build(200, { market: 1, usdinr: 0, brent: 0, vix: 0 });
    for (const [d] of [...levels.brent].filter((_, i) => i % 2 === 0)) levels.brent.delete(d);
    expect(computeExposure(returns, levels)).toMatchObject({ ok: false, reason: "insufficient_factor_coverage" });
  });
});
