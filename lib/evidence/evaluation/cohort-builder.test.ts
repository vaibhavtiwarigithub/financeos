import { describe, it, expect } from "vitest";
import {
  assembleCohort,
  buildCandidateObservation,
  buildLegacyObservation,
  legacyIncludedMask,
  resolveFrozenObservations,
  shapeOf,
  type FrozenObservationSet,
  type LegacyDecision,
  type ResolveFn,
} from "@/lib/evidence/evaluation/cohort-builder";
import { evaluateCohort, type FrozenCohort } from "@/lib/evidence/evaluation/cohort";
import { computeWeightedAnalystScore } from "@/lib/scoring/weighted-score";
import type { EvidenceEnvelope, EvidenceIntent, Market, MetricBasis } from "@/lib/evidence/contracts";

// ── fixtures ─────────────────────────────────────────────────────────────────

const US: Market = "us";
const WEIGHTS = { fundamental: 0.3, technical: 0.25, sentiment: 0.2, macro: 0.15, insider: 0.1 };

function freshEnv(
  market: Market,
  symbol: string,
  intent: EvidenceIntent,
  cacheState: "fresh" | "miss" | "stale" = "fresh",
  basis: MetricBasis = "eod",
): EvidenceEnvelope {
  return {
    schemaVersion: "evidence-v1",
    market,
    symbol,
    intent,
    quality: cacheState === "stale" ? "stale" : "fresh",
    payload: { ok: true, dimensionScore: 70 },
    provenance: [{ providerId: "massive", providerField: "x", basis, retrievedAt: new Date().toISOString(), unit: "currency" }],
    providersAttempted: cacheState === "fresh" ? [] : ["massive"],
    policyVersionId: "pv1",
    cacheState,
    resolvedAt: new Date().toISOString(),
  };
}

function unavailableEnv(market: Market, symbol: string, intent: EvidenceIntent): EvidenceEnvelope {
  return {
    schemaVersion: "evidence-v1",
    market,
    symbol,
    intent,
    quality: "unavailable",
    payload: null,
    provenance: [],
    providersAttempted: ["massive"],
    policyVersionId: "pv1",
    cacheState: "miss",
    unavailableReason: "chain_exhausted",
    resolvedAt: new Date().toISOString(),
  };
}

/** A decision with all dimensions available (a healthy US equity). */
function decision(overrides: Partial<LegacyDecision> = {}): LegacyDecision {
  return {
    symbol: "AAA",
    shape: "equity",
    isHeld: false,
    scores: { fundamental: 70, technical: 70, sentiment: 70, macro: 60, insider: 50 },
    dataQuality: {
      fundamentalDataAvailable: true,
      technicalDataPoints: 200,
      sentimentDataAvailable: true,
      macroDataAvailable: true,
      insiderDataAvailable: true,
    },
    recordedAnalystScore: 0,
    recordedDirection: "long",
    asOf: "2026-07-17T13:00:00Z",
    asOfSession: "2026-07-16",
    ...overrides,
  };
}

/** Build a snapshot where every intent for the given symbols is usable/fresh. */
function fullSnapshot(market: Market, symbols: string[], intents: EvidenceIntent[]): FrozenObservationSet {
  const observations = new Map<string, EvidenceEnvelope>();
  for (const s of symbols) for (const i of intents) {
    const key = i === "macro.regime_inputs" ? `__MARKET__|${i}` : `${s.toUpperCase()}|${i}`;
    observations.set(key, freshEnv(market, s, i));
  }
  return { snapshotId: "snap-test", market, asOf: "2026-07-17T13:00:00Z", observations, providerCalls: 0, cacheHits: 0, runId: "test" };
}

const ALL_INTENTS: EvidenceIntent[] = [
  "price.daily_bars",
  "fundamentals.reported",
  "sentiment.news",
  "macro.regime_inputs",
  "insider.transactions",
];

// ── §4.2 — ONE frozen set, reused; a dual-run never doubles provider calls ────

describe("cohort builder — frozen observation reuse (no double burst)", () => {
  it("resolves each (symbol,intent) exactly once and reverse-shadow makes ZERO new bursts", async () => {
    // A resolver that models a warming cache: the first time a key is requested it
    // is a live fetch (miss/attempted); every subsequent request is a fresh hit.
    const requests: any[] = [];
    const resolve: ResolveFn = (async (req: any) => {
      requests.push(req);
      return freshEnv(req.market, req.symbol, req.intent, "fresh");
    }) as unknown as ResolveFn;

    // Same symbol appears in TWO decisions → its intents must be resolved once.
    const symbolIntents = [
      { symbol: "AAA", intent: "price.daily_bars" as EvidenceIntent },
      { symbol: "AAA", intent: "fundamentals.reported" as EvidenceIntent },
      { symbol: "AAA", intent: "price.daily_bars" as EvidenceIntent }, // dup
      { symbol: "BBB", intent: "price.daily_bars" as EvidenceIntent },
    ];

    const primary = await resolveFrozenObservations({ market: US, symbolIntents, asOf: "t", runId: "r:primary", resolve });
    // 3 unique keys → 3 live fetches, all counted as provider work on the baseline.
    expect(primary.observations.size).toBe(3);
    expect(primary.providerCalls).toBe(0);
    expect(primary.cacheHits).toBe(3);
    expect(requests.every((req) => req.cacheOnly === true)).toBe(true);

    // REVERSE-SHADOW over the identical window: the cache is warm → zero bursts.
    const reverse = await resolveFrozenObservations({ market: US, symbolIntents, asOf: "t", runId: "r:reverse", resolve });
    expect(requests).toHaveLength(6);
    expect(reverse.providerCalls).toBe(0);
    expect(reverse.cacheHits).toBe(3);
  });

  it("assembleCohort never resolves — both legs read the ONE passed-in snapshot", () => {
    // assembleCohort takes a snapshot object and cannot fetch. Calling it twice
    // (candidate primary, then a reverse pass) touches no resolver at all.
    const snap = fullSnapshot(US, ["AAA"], ALL_INTENTS);
    const decisions = [decision({ symbol: "AAA" })];
    const base = {
      evaluationId: "e", market: US, asOf: "t", marketSessionDate: "2026-07-17", universeSnapshotId: snap.snapshotId,
      baselinePolicyVersionId: "pv1", candidatePolicyVersionId: "pv1", strategyVersion: "v1",
      weights: WEIGHTS, scoreThreshold: 60, priceBasis: "eod_adjusted",
      coverageNonInferiorityMargin: 0.05, maxAdverseRankDisplacement: 5, decisions, snapshot: snap,
    };
    const a = assembleCohort(base);
    const b = assembleCohort(base);
    // Deterministic + snapshot-driven: identical rows, no side effects.
    expect(a.rows.length).toBe(1);
    expect(b.rows[0].candidate.included).toEqual(a.rows[0].candidate.included);
  });
});

// ── §4 — parity compares semantic axes BEFORE values ─────────────────────────

describe("cohort builder — parity semantics before values", () => {
  it("a cross-family basis mismatch hard-fails the candidate even when scores are identical", () => {
    const dec = decision({
      symbol: "AAA",
      scores: { fundamental: 70, technical: 70, sentiment: 70, macro: 70, insider: 70 },
    });
    const snap = fullSnapshot(US, ["AAA"], ALL_INTENTS);
    const legacy = buildLegacyObservation(dec, US);
    const candidate = buildCandidateObservation(dec, US, snap);

    // Identical scores on both legs (no value divergence at all)...
    expect(candidate.scores).toEqual(legacy.scores);
    // ...and give the fundamental field the SAME numeric value on both sides, so
    // the only thing that differs is the basis. A value-first comparator would
    // call these identical; a semantics-first one must reject them: TTM and
    // QUARTERLY are different facts, no tolerance applies even when numbers agree.
    legacy.fields["fundamental.reported_core"] = {
      ...legacy.fields["fundamental.reported_core"],
      value: 5, basis: "ttm", providerId: "legacy",
    };
    candidate.fields["fundamental.reported_core"] = {
      ...candidate.fields["fundamental.reported_core"],
      value: 5, basis: "quarterly", providerId: "finnhub",
    };

    const cohort: FrozenCohort = {
      evaluationId: "e", market: US, asOf: "t", marketSessionDate: "2026-07-17", universeSnapshotId: "u",
      baselinePolicyVersionId: "pv1", candidatePolicyVersionId: "pv1", strategyVersion: "v1",
      weights: WEIGHTS, scoreThreshold: 60, priceBasis: "eod_adjusted",
      rows: [{ symbol: "AAA", shape: "equity", isHeld: false, legacy, candidate }],
      evaluationCodeVersion: "evidence-evaluation-v1",
      coverageNonInferiorityMargin: 0.05, maxAdverseRankDisplacement: 5,
    };
    const evalResult = evaluateCohort(cohort);
    expect(evalResult.counts.hardSemanticFailures).toBeGreaterThanOrEqual(1);
    expect(evalResult.passed).toBe(false);
    expect(evalResult.failures.some((f) => f.code === "hard_semantic_failure")).toBe(true);
  });
});

// ── §4 — abstained / failed rows are RETAINED, never dropped ─────────────────

describe("cohort builder — abstain/fail rows retained", () => {
  it("a symbol the router cannot serve at all is a first-class abstain row", () => {
    const dec = decision({ symbol: "AAA" });
    // Router has NOTHING usable for AAA.
    const empty: FrozenObservationSet = {
      snapshotId: "s", market: US, asOf: "t", observations: new Map(), providerCalls: 0, cacheHits: 0, runId: "t",
    };
    const candidate = buildCandidateObservation(dec, US, empty);
    expect(candidate.status).toBe("abstained");
    expect(Object.values(candidate.included).every((v) => v === false)).toBe(true);

    const cohort = assembleCohort({
      evaluationId: "e", market: US, asOf: "t", marketSessionDate: "2026-07-17", universeSnapshotId: "u",
      baselinePolicyVersionId: "pv1", candidatePolicyVersionId: "pv1", strategyVersion: "v1",
      weights: WEIGHTS, scoreThreshold: 60, priceBasis: "eod_adjusted",
      coverageNonInferiorityMargin: 0.05, maxAdverseRankDisplacement: 5,
      decisions: [dec], snapshot: empty,
    });
    const evalResult = evaluateCohort(cohort);
    // The row is present and counted, NOT filtered out.
    expect(evalResult.counts.symbols).toBe(1);
    expect(evalResult.counts.candidateAbstainedOrFailed).toBe(1);
    expect(evalResult.deltas.map((d) => d.symbol)).toContain("AAA");
    // A both-legs comparison of an unavailable candidate is retained, not skipped.
    const d = evalResult.deltas[0];
    expect(d.candidate.eligible).toBe(false);
  });
});

// ── legacy leg reproduces the recorded production score (no re-implementation) ─

describe("cohort builder — legacy leg reproduces the recorded score", () => {
  it("replays the exact recorded analyst_score from the frozen mask + weights", () => {
    // The real CELH row: insider unavailable, others present; 4 dims renormalized.
    const dec = decision({
      symbol: "CELH",
      scores: { fundamental: 48, technical: 24, sentiment: 78, macro: 60, insider: 50 },
      dataQuality: {
        fundamentalDataAvailable: true, technicalDataPoints: 160,
        sentimentDataAvailable: true, macroDataAvailable: true, insiderDataAvailable: false,
      },
      recordedAnalystScore: 50,
    });
    const legacy = buildLegacyObservation(dec, US);
    expect(legacy.included.insider).toBe(false);
    const { score } = computeWeightedAnalystScore(legacy.scores, legacy.included, WEIGHTS);
    expect(score).toBe(50); // matches prod exactly
  });
});

// ── the v1 safety scenario: dropping an unrouted dim can't fabricate eligibility

describe("cohort builder — availability-driven eligibility flips are blocked", () => {
  it("blocks a new long created only because the router dropped an unrouted dimension", () => {
    // macro (60) is DRAGGING the score below threshold. If the router — which has
    // no macro adapter — drops macro, the renormalized score would cross 60 and
    // create a NEW long. §5 says that flip is an artifact and must block.
    const dec = decision({
      symbol: "FLIP",
      // With macro+sentiment included: score < 60. Without them: >= 60.
      scores: { fundamental: 80, technical: 80, sentiment: 20, macro: 20, insider: 80 },
      dataQuality: {
        fundamentalDataAvailable: true, technicalDataPoints: 200,
        sentimentDataAvailable: true, macroDataAvailable: true, insiderDataAvailable: true,
      },
    });
    // legacy: all 5 dims. score = 80*.3+80*.25+20*.2+20*.15+80*.1 = 24+20+4+3+8 = 59 → neutral.
    const legacy = buildLegacyObservation(dec, US);
    const legacyScore = computeWeightedAnalystScore(legacy.scores, legacy.included, WEIGHTS).score;
    expect(legacyScore).toBeLessThan(60);

    // candidate: router serves only technical, fundamental, insider (no macro/sentiment).
    const observations = new Map<string, EvidenceEnvelope>();
    observations.set("FLIP|price.daily_bars", freshEnv(US, "FLIP", "price.daily_bars"));
    observations.set("FLIP|fundamentals.reported", freshEnv(US, "FLIP", "fundamentals.reported"));
    observations.set("FLIP|insider.transactions", freshEnv(US, "FLIP", "insider.transactions"));
    const snap: FrozenObservationSet = { snapshotId: "s", market: US, asOf: "t", observations, providerCalls: 0, cacheHits: 0, runId: "t" };

    const cohort = assembleCohort({
      evaluationId: "e", market: US, asOf: "t", marketSessionDate: "2026-07-17", universeSnapshotId: "u",
      baselinePolicyVersionId: "pv1", candidatePolicyVersionId: "pv1", strategyVersion: "v1",
      weights: WEIGHTS, scoreThreshold: 60, priceBasis: "eod_adjusted",
      coverageNonInferiorityMargin: 1, // disable coverage gate so we isolate the flip gate
      maxAdverseRankDisplacement: 5, decisions: [dec], snapshot: snap,
    });
    const evalResult = evaluateCohort(cohort);
    const d = evalResult.deltas.find((x) => x.symbol === "FLIP")!;
    // candidate became eligible purely from renormalizing around dropped dims...
    expect(d.candidate.eligible).toBe(true);
    expect(d.flip).toBe("ineligible_to_eligible");
    // ...and that is BLOCKED as an artifact, not accepted as a real signal.
    expect(d.blocking).toBe(true);
    expect(evalResult.passed).toBe(false);
    expect(evalResult.failures.some((f) => f.code === "artifact_created_eligibility")).toBe(true);
  });
});

// ── shape mapping ─────────────────────────────────────────────────────────────

describe("cohort builder — shapeOf", () => {
  it("maps asset_class to scorer shape", () => {
    expect(shapeOf("metal", "GLD")).toBe("metal");
    expect(shapeOf("etf", "XLK")).toBe("etf");
    expect(shapeOf("us_equity", "AAPL")).toBe("equity");
    expect(shapeOf("india", "RELIANCE")).toBe("equity");
  });

  it("legacyIncludedMask excludes fundamentals for ETFs", () => {
    const dec = decision({ shape: "etf", dataQuality: { fundamentalDataAvailable: true, technicalDataPoints: 200, sentimentDataAvailable: true, macroDataAvailable: true, insiderDataAvailable: true } });
    expect(legacyIncludedMask(dec).fundamental).toBe(false);
  });
});
