// Runtime evidence-degradation guard — behavioral proof (router-cutover §6, §11).
//
// These tests exist to prove the SAFETY properties, not to exercise the happy
// path: the guard may only subtract, may never suppress an exit, and may never
// default to a more permissive score.

import { describe, expect, it } from "vitest";
import {
  applyDegradationGuard,
  evaluateDegradation,
  isUsable,
  parseGuardMode,
  type FieldMask,
  type FieldObservation,
  type FieldState,
} from "@/lib/evidence/degradation-guard";
import { fieldContract } from "@/lib/evidence/intent-classification";
import { observationsFromLegacyMask, symbolShapeOf } from "@/lib/evidence/degradation-runtime";

const usable: FieldState = { availability: "available", quality: "fresh", ageSeconds: 3600, contractOk: true };
const missing: FieldState = { availability: "missing", quality: "unavailable", ageSeconds: null, contractOk: false };

function obs(over: Partial<FieldObservation> & { fieldId: string }): FieldObservation {
  return {
    availability: "available",
    quality: "fresh",
    ageSeconds: 3600,
    contractOk: true,
    renormalizedAround: false,
    ...over,
  };
}

function baselineAllGood(): FieldMask {
  return {
    "technical.daily_bars": { ...usable },
    "fundamental.reported_core": { ...usable },
    "sentiment.news_tone": { ...usable },
    "insider.net_flow": { ...usable },
    "macro.regime": { ...usable },
  };
}

function evaluate(observations: FieldObservation[], baseline: FieldMask | null, over: Partial<Parameters<typeof evaluateDegradation>[0]> = {}) {
  return evaluateDegradation({
    market: "us",
    symbol: "TEST",
    shape: "equity",
    isHeld: false,
    observations,
    baseline,
    policyVersionId: "pv-1",
    evidenceRunId: "run-1",
    ...over,
  });
}

describe("degradation guard — required-field degradation", () => {
  it("abstains from a new long when a required field goes available → missing and the score renormalized around it", () => {
    const d = evaluate(
      [
        obs({ fieldId: "technical.daily_bars" }),
        obs({ fieldId: "fundamental.reported_core", availability: "missing", quality: "unavailable", contractOk: false, renormalizedAround: true }),
        obs({ fieldId: "sentiment.news_tone" }),
        obs({ fieldId: "insider.net_flow" }),
        obs({ fieldId: "macro.regime" }),
      ],
      baselineAllGood(),
    );
    expect(d.action).toBe("abstain_new_long");
    expect(d.blockingCodes).toContain("required_field_unusable");
    expect(d.blockingCodes).toContain("available_to_missing");
    // A degraded run must NOT become the new baseline, or the guard blinds itself.
    expect(d.baselineAcceptable).toBe(false);
  });

  it("abstains when a required field ages past its ceiling (fresh → stale beyond ceiling)", () => {
    const contract = fieldContract("technical.daily_bars")!;
    const d = evaluate(
      [
        obs({
          fieldId: "technical.daily_bars",
          quality: "stale",
          ageSeconds: contract.maxAgeSeconds + 1,
          renormalizedAround: true,
        }),
        obs({ fieldId: "fundamental.reported_core" }),
        obs({ fieldId: "sentiment.news_tone" }),
        obs({ fieldId: "insider.net_flow" }),
        obs({ fieldId: "macro.regime" }),
      ],
      baselineAllGood(),
    );
    expect(d.action).toBe("abstain_new_long");
    expect(d.blockingCodes).toContain("fresh_to_stale_beyond_ceiling");
  });

  it("does NOT abstain on stale-but-within-ceiling — stale is acceptable when the contract says so", () => {
    const contract = fieldContract("technical.daily_bars")!;
    const d = evaluate(
      [
        obs({ fieldId: "technical.daily_bars", quality: "stale", ageSeconds: contract.maxAgeSeconds - 1 }),
        obs({ fieldId: "fundamental.reported_core" }),
        obs({ fieldId: "sentiment.news_tone" }),
        obs({ fieldId: "insider.net_flow" }),
        obs({ fieldId: "macro.regime" }),
      ],
      baselineAllGood(),
    );
    expect(d.action).toBe("allow");
  });

  it("treats conflict and quarantined as DISTINCT from missing and from zero", () => {
    for (const [quality, code] of [["conflict", "valid_to_conflict"], ["quarantined", "valid_to_quarantined"]] as const) {
      const d = evaluate(
        [
          obs({ fieldId: "technical.daily_bars", quality, renormalizedAround: true }),
          obs({ fieldId: "fundamental.reported_core" }),
          obs({ fieldId: "sentiment.news_tone" }),
          obs({ fieldId: "insider.net_flow" }),
          obs({ fieldId: "macro.regime" }),
        ],
        baselineAllGood(),
      );
      expect(d.action).toBe("abstain_new_long");
      expect(d.blockingCodes).toContain(code);
      // Crucially: the field is not scored as 0 or neutral, it is unusable.
      expect(isUsable(d.currentMask["technical.daily_bars"], fieldContract("technical.daily_bars")!)).toBe(false);
    }
  });

  it("does NOT abstain when an OPTIONAL field degrades — that renormalizes, as today", () => {
    const d = evaluate(
      [
        obs({ fieldId: "technical.daily_bars" }),
        obs({ fieldId: "fundamental.reported_core" }),
        obs({ fieldId: "sentiment.news_tone", availability: "missing", quality: "unavailable", contractOk: false, renormalizedAround: true }),
        obs({ fieldId: "insider.net_flow", availability: "missing", quality: "unavailable", contractOk: false, renormalizedAround: true }),
        obs({ fieldId: "macro.regime" }),
      ],
      baselineAllGood(),
    );
    expect(d.action).toBe("allow");
  });

  it("does NOT abstain when a required field is unusable but the scorer did NOT renormalize around it", () => {
    // No causation → no abstain. The degradation is still recorded.
    const d = evaluate(
      [
        obs({ fieldId: "technical.daily_bars" }),
        obs({ fieldId: "fundamental.reported_core", availability: "missing", quality: "unavailable", contractOk: false, renormalizedAround: false }),
        obs({ fieldId: "sentiment.news_tone" }),
        obs({ fieldId: "insider.net_flow" }),
        obs({ fieldId: "macro.regime" }),
      ],
      baselineAllGood(),
    );
    expect(d.action).toBe("allow");
    const t = d.transitions.find((x) => x.fieldId === "fundamental.reported_core")!;
    expect(t.code).toBe("available_to_missing");
    expect(t.blocking).toBe(false);
  });
});

describe("degradation guard — required-field gate overrides the two-dimension floor (§6.4)", () => {
  it("abstains even when two OTHER dimensions are present and the score is not thin", () => {
    // sentiment + macro + insider present = 3 usable dims → isThinEvidence()==false.
    // The legacy floor would happily open a long. The required-field gate does not.
    const d = evaluate(
      [
        obs({ fieldId: "technical.daily_bars", availability: "missing", quality: "unavailable", contractOk: false, renormalizedAround: true }),
        obs({ fieldId: "fundamental.reported_core", availability: "missing", quality: "unavailable", contractOk: false, renormalizedAround: true }),
        obs({ fieldId: "sentiment.news_tone" }),
        obs({ fieldId: "insider.net_flow" }),
        obs({ fieldId: "macro.regime" }),
      ],
      baselineAllGood(),
    );
    expect(d.action).toBe("abstain_new_long");
  });

  it("a required field below its minimum contract (bars < 15) is unusable, not neutral", () => {
    const legacyObs = observationsFromLegacyMask({
      isEtf: false, isAdr: false, isMetal: false,
      applicable: new Set(["technical", "fundamental", "sentiment", "insider", "macro"]),
      // A 1-14 bar sliver: the legacy mask already excludes it from `included`.
      included: { technical: false, fundamental: true, sentiment: true, insider: true, macro: true },
      renormalized: true,
      technicalDataPoints: 9,
    });
    const d = evaluate(legacyObs, baselineAllGood());
    expect(d.action).toBe("abstain_new_long");
    expect(d.currentMask["technical.daily_bars"].contractOk).toBe(false);
  });
});

describe("degradation guard — applicability", () => {
  it("never degrades a structurally not-applicable field (ETF fundamentals)", () => {
    const legacyObs = observationsFromLegacyMask({
      isEtf: true, isAdr: false, isMetal: false,
      applicable: new Set(["technical", "sentiment", "macro"]),
      included: { technical: true, sentiment: true, macro: true },
      renormalized: false,
      technicalDataPoints: 120,
    });
    const d = evaluate(legacyObs, null, { shape: "etf" });
    expect(d.action).toBe("allow");
    const t = d.transitions.find((x) => x.fieldId === "fundamental.reported_core")!;
    expect(t.code).toBe("not_applicable");
  });

  it("US ADRs have no Form 4 — insider absence is not a degradation", () => {
    const legacyObs = observationsFromLegacyMask({
      isEtf: false, isAdr: true, isMetal: false,
      applicable: new Set(["technical", "fundamental", "sentiment", "macro"]),
      included: { technical: true, fundamental: true, sentiment: true, macro: true },
      renormalized: false,
      technicalDataPoints: 120,
    });
    const d = evaluate(legacyObs, null, { shape: "adr" });
    expect(d.action).toBe("allow");
    expect(d.transitions.find((x) => x.fieldId === "insider.net_flow")!.code).toBe("not_applicable");
  });

  it("symbolShapeOf classifies metal/etf/adr/equity", () => {
    expect(symbolShapeOf({ isEtf: true, isAdr: false, isMetal: true })).toBe("metal");
    expect(symbolShapeOf({ isEtf: true, isAdr: false, isMetal: false })).toBe("etf");
    expect(symbolShapeOf({ isEtf: false, isAdr: true, isMetal: false })).toBe("adr");
    expect(symbolShapeOf({ isEtf: false, isAdr: false, isMetal: false })).toBe("equity");
  });
});

describe("degradation guard — defaults to abstain, never to permissive", () => {
  it("with NO baseline, an unusable required field still abstains", () => {
    const d = evaluate(
      [
        obs({ fieldId: "technical.daily_bars", availability: "missing", quality: "unavailable", contractOk: false, renormalizedAround: true }),
        obs({ fieldId: "fundamental.reported_core" }),
        obs({ fieldId: "sentiment.news_tone" }),
        obs({ fieldId: "insider.net_flow" }),
        obs({ fieldId: "macro.regime" }),
      ],
      null,
    );
    expect(d.action).toBe("abstain_new_long");
    expect(d.blockingCodes).toContain("no_baseline_required_field");
  });

  it("a PERSISTENT outage (unusable at baseline too) keeps abstaining — it does not normalize", () => {
    const degradedBaseline: FieldMask = { ...baselineAllGood(), "technical.daily_bars": { ...missing } };
    const d = evaluate(
      [
        obs({ fieldId: "technical.daily_bars", availability: "missing", quality: "unavailable", contractOk: false, renormalizedAround: true }),
        obs({ fieldId: "fundamental.reported_core" }),
        obs({ fieldId: "sentiment.news_tone" }),
        obs({ fieldId: "insider.net_flow" }),
        obs({ fieldId: "macro.regime" }),
      ],
      degradedBaseline,
    );
    expect(d.action).toBe("abstain_new_long");
  });

  it("an unreadable guard mode falls back to measure_only — never silently enforces or disables", () => {
    expect(parseGuardMode(undefined)).toBe("measure_only");
    expect(parseGuardMode("")).toBe("measure_only");
    expect(parseGuardMode("ENFORCE_MAYBE")).toBe("measure_only");
    expect(parseGuardMode("enforce")).toBe("enforce");
    expect(parseGuardMode("off")).toBe("off");
  });

  it("a clean run is promoted to baseline; a degraded one is not", () => {
    const clean = evaluate(
      [
        obs({ fieldId: "technical.daily_bars" }),
        obs({ fieldId: "fundamental.reported_core" }),
        obs({ fieldId: "sentiment.news_tone" }),
        obs({ fieldId: "insider.net_flow" }),
        obs({ fieldId: "macro.regime" }),
      ],
      baselineAllGood(),
    );
    expect(clean.baselineAcceptable).toBe(true);
  });
});

describe("degradation guard — application is STRICTLY subtractive", () => {
  const abstaining = () =>
    evaluate(
      [
        obs({ fieldId: "technical.daily_bars", availability: "missing", quality: "unavailable", contractOk: false, renormalizedAround: true }),
        obs({ fieldId: "fundamental.reported_core" }),
        obs({ fieldId: "sentiment.news_tone" }),
        obs({ fieldId: "insider.net_flow" }),
        obs({ fieldId: "macro.regime" }),
      ],
      baselineAllGood(),
    );

  it("enforce mode downgrades long → neutral", () => {
    const a = applyDegradationGuard("long", abstaining(), "enforce");
    expect(a.direction).toBe("neutral");
    expect(a.applied).toBe(true);
  });

  it("NEVER suppresses an exit: a held position's 'short' passes through in every mode", () => {
    for (const mode of ["off", "measure_only", "enforce"] as const) {
      const a = applyDegradationGuard("short", abstaining(), mode);
      expect(a.direction).toBe("short");
      expect(a.applied).toBe(false);
    }
  });

  it("never creates or upgrades a signal — 'neutral' stays neutral", () => {
    for (const mode of ["off", "measure_only", "enforce"] as const) {
      expect(applyDegradationGuard("neutral", abstaining(), mode).direction).toBe("neutral");
    }
  });

  it("measure-only records what it WOULD do and changes nothing", () => {
    const a = applyDegradationGuard("long", abstaining(), "measure_only");
    expect(a.direction).toBe("long");
    expect(a.applied).toBe(false);
    expect(a.wouldAbstain).toBe(true);
    expect(a.note).toContain("WOULD abstain");
  });

  it("an 'allow' decision never alters any direction", () => {
    const clean = evaluate([obs({ fieldId: "technical.daily_bars" }), obs({ fieldId: "fundamental.reported_core" }), obs({ fieldId: "sentiment.news_tone" }), obs({ fieldId: "insider.net_flow" }), obs({ fieldId: "macro.regime" })], baselineAllGood());
    for (const dir of ["long", "neutral", "short"] as const) {
      expect(applyDegradationGuard(dir, clean, "enforce").direction).toBe(dir);
    }
  });
});

describe("degradation guard — cohort-rank behavior", () => {
  // A single symbol's degradation must not silently promote OTHER symbols into
  // the top ranks. The guard removes the degraded name from the candidate set;
  // it must never add one. Proven here across a whole cohort.
  it("abstaining one symbol only ever shrinks the eligible set — never grows it", () => {
    const cohort = ["AAA", "BBB", "CCC", "DDD"];
    const degraded = new Set(["BBB"]);
    const eligibleBefore: string[] = [];
    const eligibleAfter: string[] = [];

    for (const symbol of cohort) {
      const d = evaluate(
        [
          obs({
            fieldId: "technical.daily_bars",
            ...(degraded.has(symbol)
              ? { availability: "missing" as const, quality: "unavailable" as const, contractOk: false, renormalizedAround: true }
              : {}),
          }),
          obs({ fieldId: "fundamental.reported_core" }),
          obs({ fieldId: "sentiment.news_tone" }),
          obs({ fieldId: "insider.net_flow" }),
          obs({ fieldId: "macro.regime" }),
        ],
        baselineAllGood(),
        { symbol },
      );
      // Every symbol proposes a long pre-guard.
      eligibleBefore.push(symbol);
      if (applyDegradationGuard("long", d, "enforce").direction === "long") eligibleAfter.push(symbol);
    }

    expect(eligibleBefore).toEqual(["AAA", "BBB", "CCC", "DDD"]);
    expect(eligibleAfter).toEqual(["AAA", "CCC", "DDD"]);
    // The invariant: the post-guard set is a strict SUBSET of the pre-guard set.
    expect(eligibleAfter.every((s) => eligibleBefore.includes(s))).toBe(true);
    expect(eligibleAfter.length).toBeLessThanOrEqual(eligibleBefore.length);
  });

  it("a provider outage across the WHOLE cohort abstains every new long rather than re-ranking survivors", () => {
    // The dangerous shape: a total required-field outage. The wrong behavior is
    // to renormalize everyone onto the remaining dims and keep picking a "top 3".
    const results = ["AAA", "BBB", "CCC"].map((symbol) =>
      applyDegradationGuard(
        "long",
        evaluate(
          [
            obs({ fieldId: "technical.daily_bars", availability: "missing", quality: "unavailable", contractOk: false, renormalizedAround: true }),
            obs({ fieldId: "fundamental.reported_core" }),
            obs({ fieldId: "sentiment.news_tone" }),
            obs({ fieldId: "insider.net_flow" }),
            obs({ fieldId: "macro.regime" }),
          ],
          baselineAllGood(),
          { symbol },
        ),
        "enforce",
      ),
    );
    expect(results.every((r) => r.direction === "neutral")).toBe(true);
  });
});
