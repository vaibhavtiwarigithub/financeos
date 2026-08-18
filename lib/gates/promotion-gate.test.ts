import { describe, it, expect } from "vitest";
import { evaluateGate, providerRegimeKey } from "./promotion-gate";

// A clean-passing edge: IC well above floor, strong t-stats, no decay, 1 trial.
const PASSING = { ics: [0.05, 0.055, 0.06], tStats: [2.4, 2.6, 2.8], trialsRun: 1 };

describe("evaluateGate", () => {
  it("passes a strong, stable edge", () => {
    const r = evaluateGate(PASSING);
    expect(r.pass).toBe(true);
    expect(r.reasons).toEqual([]);
    expect(r.sample_n).toBe(3);
    expect(r.ic_stability_pass).toBe(true);
    expect(r.t_margin_vs_trials).toBeCloseTo(2.8, 5); // trialsRun=1 → no DSR penalty
  });

  it("rejects fewer than 3 IC windows without evaluating other gates", () => {
    const r = evaluateGate({ ics: [0.05, 0.06], tStats: [3, 3], trialsRun: 1 });
    expect(r.pass).toBe(false);
    expect(r.reasons).toEqual(["insufficient_windows:2<3"]);
    expect(r.t_stat_latest).toBeNull();
  });

  it("rejects when latest IC is below the floor", () => {
    const r = evaluateGate({ ...PASSING, ics: [0.05, 0.04, 0.01] });
    expect(r.pass).toBe(false);
    expect(r.reasons.some((x) => x.startsWith("ic_below_floor"))).toBe(true);
  });

  it("rejects when the best t-stat misses the hurdle", () => {
    const r = evaluateGate({ ...PASSING, tStats: [1.2, 1.5, 1.9] });
    expect(r.pass).toBe(false);
    expect(r.reasons.some((x) => x.startsWith("t_stat_below_hurdle"))).toBe(true);
  });

  it("subtracts a larger expected-max-t as variant count rises", () => {
    const at1 = evaluateGate({ ...PASSING, tStats: [2.4, 2.4, 2.4], trialsRun: 1 });
    const at20 = evaluateGate({ ...PASSING, tStats: [2.4, 2.4, 2.4], trialsRun: 20 });
    expect(at1.t_margin_vs_trials).toBeCloseTo(2.4, 5);        // S=1 → no penalty
    expect(at20.t_margin_vs_trials).toBeCloseTo(2.4 - 1.96, 2); // S=20 → E[max t] ≈ 1.96
    expect(at20.t_margin_vs_trials! < at1.t_margin_vs_trials!).toBe(true);
  });

  it("fails the trial-count adjustment when the penalty exceeds the t-stat", () => {
    // Needs S > ~22 for E[max t] to clear the 2.0 hurdle, so this only bites
    // above the schema's variant_budget ceiling of 20 — see note in the route.
    const r = evaluateGate({ ...PASSING, tStats: [2.0, 2.1, 2.1], trialsRun: 200 });
    expect(r.pass).toBe(false);
    expect(r.t_margin_vs_trials! < 0).toBe(true);
    expect(r.reasons.some((x) => x.startsWith("trial_adjusted_t_failed"))).toBe(true);
  });

  it("uses the LATEST window t-stat, never the max across windows", () => {
    // Real shape from prod: dma_trend_slope@20d read 2.83 as a max and 0.55 as
    // its latest window. Taking the max promoted an edge whose current evidence
    // is nowhere near the hurdle.
    const r = evaluateGate({ ics: [0.04, 0.05, 0.045], tStats: [2.83, 2.4, 0.55], trialsRun: 1 });
    expect(r.t_stat_latest).toBeCloseTo(0.55, 5);
    expect(r.pass).toBe(false);
    expect(r.reasons.some((x) => x.includes("t_stat_below_hurdle:latest=0.55"))).toBe(true);
  });

  it("counts windows, so duplicate window_end rows must be deduped by the caller", () => {
    // Prod 2026-07-27: US edges had 6 rows across only 4 distinct window_end
    // values. Undeduped, a same-day re-run reads as fresh evidence and can lift
    // sample_n over MIN_WINDOWS on its own. The route dedupes before calling.
    const deduped = evaluateGate({ ics: [0.05, 0.06], tStats: [2.4, 2.5], trialsRun: 1 });
    expect(deduped.reasons).toEqual(["insufficient_windows:2<3"]);
    // Same two windows, one re-run duplicated — would have squeaked through.
    const withDupe = evaluateGate({ ics: [0.05, 0.05, 0.06], tStats: [2.4, 2.4, 2.5], trialsRun: 1 });
    expect(withDupe.sample_n).toBe(3);
    expect(withDupe.pass).toBe(true);
  });

  it("rejects an IC estimate that halved across windows", () => {
    const r = evaluateGate({ ...PASSING, ics: [0.10, 0.07, 0.04] });
    expect(r.pass).toBe(false);
    expect(r.ic_stability_pass).toBe(false);
    expect(r.reasons.some((x) => x.startsWith("ic_stability_failed"))).toBe(true);
  });

  it("fails closed on mismatched evidence arrays", () => {
    const r = evaluateGate({ ics: [0.05, 0.06, 0.07], tStats: [2.5, 2.6], trialsRun: 1 });
    expect(r.pass).toBe(false);
    expect(r.reasons).toEqual(["invalid_gate_input"]);
  });

  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])(
    "fails closed on invalid trial count %s",
    (trialsRun) => {
      const r = evaluateGate({ ...PASSING, trialsRun });
      expect(r.pass).toBe(false);
      expect(r.reasons).toEqual(["invalid_gate_input"]);
    },
  );
});

// ── Provider-regime segmentation (2026-08-18) ───────────────────────────────
//
// The US edge/IC candle ladder moved to Yahoo-first, lifting Massive's 2-year
// lookback cap. IC computed on Yahoo bars is a different measurement from IC on
// Massive/EODHD/TwelveData bars, but both land in edge_ic_history and the promote
// route reads a 1000-day window. Without segmentation the stability check would
// compare a Yahoo latest window against a Massive earliest window and report the
// difference as "stability".
describe("providerRegimeKey", () => {
  it("names the dominant provider", () => {
    expect(providerRegimeKey({ eodhd: 20, massive: 6, twelvedata: 11 })).toBe("eodhd");
    expect(providerRegimeKey({ yahoo_us: 37 })).toBe("yahoo_us");
  });

  it("ignores run-to-run jitter — same regime, same key", () => {
    // Over-segmenting on exact counts would starve the gate of windows.
    expect(providerRegimeKey({ eodhd: 20, massive: 6 }))
      .toBe(providerRegimeKey({ eodhd: 19, massive: 7 }));
  });

  it("breaks ties deterministically", () => {
    expect(providerRegimeKey({ massive: 5, eodhd: 5 })).toBe("eodhd");
    expect(providerRegimeKey({ eodhd: 5, massive: 5 })).toBe("eodhd");
  });

  it("returns 'unknown' for missing, empty, or zero-count reports", () => {
    expect(providerRegimeKey(undefined)).toBe("unknown");
    expect(providerRegimeKey(null)).toBe("unknown");
    expect(providerRegimeKey({})).toBe("unknown");
    expect(providerRegimeKey({ eodhd: 0 })).toBe("unknown");
  });
});

describe("evaluateGate — provider-regime segmentation", () => {
  const OLD = "eodhd";
  const NEW = "yahoo_us";

  it("is unchanged when no regimes are supplied (back-compat)", () => {
    expect(evaluateGate(PASSING).pass).toBe(evaluateGate({ ...PASSING }).pass);
    expect(evaluateGate(PASSING).provider_regime).toBeUndefined();
  });

  it("evaluates only the latest regime's windows, dropping the older ones", () => {
    // 3 clean new-regime windows preceded by 3 old-regime windows.
    const r = evaluateGate({
      ics: [0.9, 0.9, 0.9, ...PASSING.ics],
      tStats: [9, 9, 9, ...PASSING.tStats],
      trialsRun: PASSING.trialsRun,
      providerRegimes: [OLD, OLD, OLD, NEW, NEW, NEW],
    });
    expect(r.provider_regime).toBe(NEW);
    expect(r.windows_dropped_other_regime).toBe(3);
    expect(r.sample_n).toBe(PASSING.ics.length);
    // The absurd 0.9 old-regime ICs must not have entered the stability check.
    expect(r.pass).toBe(evaluateGate(PASSING).pass);
  });

  it("FAILS CLOSED right after a provider change — too few clean windows", () => {
    const r = evaluateGate({
      ics: [0.05, 0.05, 0.05, 0.05],
      tStats: [3, 3, 3, 3],
      trialsRun: 1,
      providerRegimes: [OLD, OLD, OLD, NEW],
    });
    expect(r.pass).toBe(false);
    expect(r.sample_n).toBe(1);
    expect(r.windows_dropped_other_regime).toBe(3);
    expect(r.reasons[0]).toBe(`insufficient_windows_in_provider_regime:1<3:${NEW}`);
  });

  it("refuses a window that cannot name its own data", () => {
    const r = evaluateGate({ ...PASSING, providerRegimes: [OLD, OLD, "unknown"] });
    expect(r.pass).toBe(false);
    expect(r.reasons).toContain("provider_regime_unknown");
  });

  it("rejects a regimes array that does not line up with the windows", () => {
    const r = evaluateGate({ ...PASSING, providerRegimes: [NEW] });
    expect(r.pass).toBe(false);
    expect(r.reasons).toContain("invalid_gate_input");
  });

  it("does not drop anything when every window shares one regime", () => {
    const r = evaluateGate({ ...PASSING, providerRegimes: PASSING.ics.map(() => NEW) });
    expect(r.windows_dropped_other_regime).toBe(0);
    expect(r.sample_n).toBe(PASSING.ics.length);
    expect(r.pass).toBe(evaluateGate(PASSING).pass);
  });
});
