// Frozen dual-run evaluation — COHORT BUILDER (router-cutover §4.2, §10).
//
// This is the piece deliberately left unbuilt in the prerequisites ship: the
// step that "risks provider bursts." It resolves REAL recent research decisions
// into a `FrozenCohort` and feeds the existing decision engine
// (`evaluateCohort`) + persistence (`persistEvaluation`). It NEVER re-implements
// scoring, NEVER writes a score/signal/order, and — the one constraint that
// governs the whole design — it fetches/caches ONE market-local frozen
// observation set and hands it to BOTH legs, so a dual-run (candidate primary +
// legacy reverse-shadow) never doubles provider calls (§4.2).
//
// SHADOW ONLY. router_enabled stays false for both markets. Persisting an
// evaluation cannot activate anything — activation is a separate owner-gated RPC
// (persist.ts) that is out of scope here.
//
// ── The two legs, and what v1 honestly compares ──────────────────────────────
//
//   LEGACY leg   = a real recorded production decision (agent_signals joined to
//                  its research_packet). Its per-dimension scores and the exact
//                  availability mask that drove the weighting come straight from
//                  what production persisted — NOT reconstructed, NOT re-fetched.
//   CANDIDATE leg = the SAME frozen dimension scores, but with availability
//                  decided by the Canonical Router's freshly-resolved snapshot
//                  for those symbols at the same as-of.
//
// v1 therefore measures the axis that legacy actually persisted: EVIDENCE
// AVAILABILITY and the eligibility flips it drives (§5). It does NOT re-derive
// dimension scores from router evidence (no scorer consumes `EvidenceEnvelope`
// yet) and does NOT claim per-field VALUE or basis/period parity — legacy never
// stored raw field values or per-field provenance, so a value/basis comparison
// against it would be fabricated. Both legs therefore carry the field's CANONICAL
// contract semantics (so no cosmetic basis/unit hard-fail fires on a bundled
// field like fundamentals), the real serving provider is recorded for audit, and
// value/period are left null (not compared). This is the same honesty the
// degradation guard already ships with (`ageSeconds: null` for the legacy path).
// Real value/basis/period parity arrives when the legacy path is itself routed.

import { createHash } from "crypto";
import { createServiceClient } from "@/lib/supabase/service";
import {
  computeWeightedAnalystScore,
  SCORE_DIMENSIONS,
  type DimensionRecord,
  type ScoreDimension,
} from "@/lib/scoring/weighted-score";
import { scoreFundamentals, scoreSentiment } from "@/lib/data/scores";
import { computeTechnicals, scoreTechnicals } from "@/lib/data/technicals";
import type { Currency, EvidenceEnvelope, EvidenceIntent, Market } from "@/lib/evidence/contracts";
import {
  contractsFor,
  fieldContract,
  type ScorerFieldContract,
  type SymbolShape,
} from "@/lib/evidence/intent-classification";
import type { FieldObservationForParity } from "@/lib/evidence/evaluation/parity";
import {
  cohortFingerprint,
  evaluateCohort,
  EVALUATION_CODE_VERSION,
  type CohortEvaluation,
  type CohortRow,
  type FrozenCohort,
  type PathObservation,
} from "@/lib/evidence/evaluation/cohort";
import { persistEvaluation } from "@/lib/evidence/evaluation/persist";
import { resolveEvidence } from "@/lib/evidence/resolver";

export const COHORT_BUILDER_VERSION = "cohort-builder-v2-cache-only";

// Only score-affecting dimensions map to a router intent. Each dimension's
// availability is decided by whether the router resolved a USABLE observation of
// its backing intent. sentiment/macro have no registered adapter yet, so the
// router will report them unavailable — an EXPECTED coverage regression that can
// only make the candidate MORE conservative (§5: never blocks), never create a
// new long from thin air.
const DIMENSION_INTENT: Record<ScoreDimension, { intent: EvidenceIntent; fieldId: string }> = {
  technical: { intent: "price.daily_bars", fieldId: "technical.daily_bars" },
  fundamental: { intent: "fundamentals.reported", fieldId: "fundamental.reported_core" },
  sentiment: { intent: "sentiment.news", fieldId: "sentiment.news_tone" },
  macro: { intent: "macro.regime_inputs", fieldId: "macro.regime" },
  insider: { intent: "insider.transactions", fieldId: "insider.net_flow" },
};

/** Quality states a candidate observation may be scored on. Anything else = unusable. */
const USABLE_QUALITY = new Set(["fresh", "stale"]);

function marketCurrency(market: Market): Currency {
  return market === "india" ? "INR" : "USD";
}

// ── the legacy decision (real, recorded) ─────────────────────────────────────

/**
 * One real recorded production decision, exactly as persisted. `scores` +
 * `dataQuality` come from the research_packet's `raw_data`; `weights` are the
 * `_profile_weights` that actually drove the weighting — so the legacy leg
 * reproduces the recorded analyst_score byte-for-byte (asserted in tests).
 */
export interface LegacyDecision {
  symbol: string;
  shape: SymbolShape;
  isHeld: boolean;
  scores: DimensionRecord<number>;
  /** The scorer's availability mask, from research_packets.raw_data._data_quality. */
  dataQuality: {
    fundamentalDataAvailable?: boolean;
    technicalDataPoints?: number;
    sentimentDataAvailable?: boolean;
    macroDataAvailable?: boolean;
    insiderDataAvailable?: boolean;
  };
  /** For cross-checking the reproduced score; never used in scoring. */
  recordedAnalystScore: number;
  recordedDirection: string;
  asOf: string;
}

/**
 * The legacy availability mask, reconstructed with the EXACT rule research-agent
 * uses (research-agent.ts ~1545): a dimension is included only when its evidence
 * was really present. This is the mask that drove the recorded weighting.
 */
export function legacyIncludedMask(dec: LegacyDecision): DimensionRecord<boolean> {
  const dq = dec.dataQuality ?? {};
  const isEtf = dec.shape === "etf" || dec.shape === "metal";
  return {
    fundamental: !isEtf && (dq.fundamentalDataAvailable ?? true),
    technical: (dq.technicalDataPoints ?? 0) >= 15,
    sentiment: dq.sentimentDataAvailable ?? true,
    macro: dq.macroDataAvailable ?? true,
    insider: dq.insiderDataAvailable ?? true,
  };
}

// ── the frozen observation set (ONE per market, reused by BOTH legs) ──────────

/**
 * The single frozen observation set §4.2 turns on. It is resolved ONCE and read
 * by both the candidate leg and any reverse-shadow leg. `providerCalls` counts
 * real bursts (cache misses that reached a provider); `cacheHits` counts the
 * fresh short-circuits that cost nothing — the two together are the ledger proof
 * that a dual-run does not exceed the single-path baseline.
 */
export interface FrozenObservationSet {
  snapshotId: string;
  market: Market;
  asOf: string;
  observations: Map<string, EvidenceEnvelope>;
  providerCalls: number;
  cacheHits: number;
  runId: string;
}

const MARKET_WIDE_INTENTS = new Set<EvidenceIntent>(["macro.regime_inputs"]);

function obsKey(symbol: string, intent: EvidenceIntent): string {
  return `${MARKET_WIDE_INTENTS.has(intent) ? "__MARKET__" : symbol.toUpperCase()}|${intent}`;
}

/** Injectable so tests never touch the network. */
export type ResolveFn = typeof resolveEvidence;

/**
 * Resolve the router evidence for a set of (symbol,intent) pairs ONCE.
 *
 * Deduplicates, so a symbol appearing in several decisions is resolved a single
 * time. On a fresh cache hit `resolveEvidence` short-circuits with zero provider
 * work — which is exactly why a reverse-shadow pass over the SAME window (a
 * different runId, the cache now warm) makes no new burst.
 */
export async function resolveFrozenObservations(input: {
  market: Market;
  symbolIntents: Array<{ symbol: string; intent: EvidenceIntent }>;
  asOf: string;
  runId: string;
  policyVersionId?: string;
  resolve?: ResolveFn;
}): Promise<FrozenObservationSet> {
  const resolve = input.resolve ?? resolveEvidence;
  const observations = new Map<string, EvidenceEnvelope>();
  let providerCalls = 0;
  let cacheHits = 0;

  // Dedup — one resolve per unique (symbol,intent).
  const seen = new Set<string>();
  const unique = input.symbolIntents.filter((si) => {
    const k = obsKey(si.symbol, si.intent);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });

  for (const si of unique) {
    const env = await resolve({
      market: input.market,
      intent: si.intent,
      symbol: MARKET_WIDE_INTENTS.has(si.intent) ? undefined : si.symbol,
      asOf: input.asOf,
      runId: input.runId,
      // Shadow collection may exercise the inactive policy. This is the ONLY
      // caller class allowed past the router_enabled=false gate.
      allowDisabledPolicy: true,
      cacheOnly: true,
      policyVersionId: input.policyVersionId,
    });
    observations.set(obsKey(si.symbol, si.intent), env);
    // A fresh CACHE hit is the zero-burst path; anything else attempted a provider.
    if (env.cacheState === "fresh") cacheHits += 1;
    else if (env.providersAttempted.length > 0) providerCalls += 1;
  }

  const snapshotId =
    "snap-" +
    createHash("sha1")
      .update(`${input.market}|${input.policyVersionId ?? "active"}|${input.asOf}|${[...seen].sort().join(",")}`)
      .digest("hex")
      .slice(0, 16);

  return {
    snapshotId,
    market: input.market,
    asOf: input.asOf,
    observations,
    providerCalls,
    cacheHits,
    runId: input.runId,
  };
}

// ── pure leg construction ────────────────────────────────────────────────────

function legacyField(
  contract: ScorerFieldContract,
  present: boolean,
  market: Market,
): FieldObservationForParity {
  return {
    value: null, // v1 does not value-compare (legacy stored no raw field value)
    present,
    quality: present ? "fresh" : "unavailable",
    basis: contract.allowedBases[0] ?? null,
    periodEnd: null,
    currency: contract.unit === "text" ? null : marketCurrency(market),
    unit: contract.unit,
    adjusted: null,
    providerId: present ? "legacy" : null,
  };
}

function candidateField(
  contract: ScorerFieldContract,
  env: EvidenceEnvelope | undefined,
  market: Market,
): { obs: FieldObservationForParity; usable: boolean } {
  const usable = !!env && env.payload != null && USABLE_QUALITY.has(env.quality);
  // Real serving provider is recorded for audit; canonical contract semantics
  // are carried on both sides so no cosmetic basis/unit hard-fail fires on a
  // bundled field. quality is the router's REAL quality (fresh/stale/...).
  const providerId = usable
    ? (env!.provenance[0]?.providerId ?? env!.providersAttempted[0] ?? "router")
    : null;
  return {
    usable,
    obs: {
      value: null,
      present: usable,
      quality: env?.quality ?? "unavailable",
      basis: contract.allowedBases[0] ?? null,
      periodEnd: null,
      currency: contract.unit === "text" ? null : marketCurrency(market),
      unit: contract.unit,
      adjusted: null,
      providerId,
      conflict: env?.quality === "conflict",
    },
  };
}

function candidateDimensionScore(
  dimension: ScoreDimension,
  env: EvidenceEnvelope | undefined,
  symbol: string,
): number | null {
  if (!env?.payload || typeof env.payload !== "object") return null;
  const payload = env.payload as Record<string, any>;
  const bridged = Number(payload.dimensionScore);
  if (Number.isFinite(bridged) && bridged >= 0 && bridged <= 100) return bridged;

  if (dimension === "technical" && Array.isArray(payload.bars) && payload.bars.length >= 15) {
    return scoreTechnicals(computeTechnicals(payload.bars));
  }
  if (dimension === "fundamental") {
    const overview: Record<string, string> = { Symbol: symbol };
    const fieldMap: Record<string, string> = {
      peRatio: "PERatio",
      netMargin: "ProfitMargin",
      roe: "ReturnOnEquityTTM",
      eps: "EPS",
      revenueGrowth: "QuarterlyRevenueGrowthYOY",
      sector: "Sector",
      industry: "Industry",
    };
    for (const [canonical, legacy] of Object.entries(fieldMap)) {
      if (payload[canonical] != null) overview[legacy] = String(payload[canonical]);
    }
    return scoreFundamentals(overview, false).score;
  }
  if (dimension === "sentiment") {
    const direct = Number(payload.score);
    if (Number.isFinite(direct)) return Math.max(0, Math.min(100, Math.round(direct)));
    return scoreSentiment(payload.raw ?? payload).score;
  }
  if (dimension === "macro" || dimension === "insider") {
    const score = Number(payload.score);
    return Number.isFinite(score) && score >= 0 && score <= 100 ? score : null;
  }
  return null;
}

/**
 * Build the legacy leg from the recorded decision. `status` is always "scored":
 * a recorded decision, by definition, produced a scorable dimension set — the
 * production gate (replayed in scorePath) decides direction/eligibility from it.
 */
export function buildLegacyObservation(dec: LegacyDecision, market: Market): PathObservation {
  const included = legacyIncludedMask(dec);
  const fields: Record<string, FieldObservationForParity> = {};
  for (const contract of contractsFor(market, dec.shape)) {
    const dim = contract.dimension;
    const present = dim ? included[dim] === true : false;
    fields[contract.fieldId] = legacyField(contract, present, market);
  }
  return { status: "scored", scores: dec.scores, included, fields };
}

/**
 * Build the candidate leg from the frozen snapshot. Dimension scores are REUSED
 * from the recorded decision (v1 does not re-score); only AVAILABILITY is decided
 * by the router. A dimension is included iff it is structurally applicable AND
 * the router resolved a usable observation of its intent. If nothing is usable,
 * the leg abstains — retained as a first-class row (§4), never dropped.
 */
export function buildCandidateObservation(
  dec: LegacyDecision,
  market: Market,
  snapshot: FrozenObservationSet,
): PathObservation {
  const included: DimensionRecord<boolean> = {
    fundamental: false,
    technical: false,
    sentiment: false,
    macro: false,
    insider: false,
  };
  const candidateScores: DimensionRecord<number> = { ...dec.scores };
  const fields: Record<string, FieldObservationForParity> = {};

  for (const contract of contractsFor(market, dec.shape)) {
    const dim = contract.dimension;
    const intent = dim ? DIMENSION_INTENT[dim]?.intent : undefined;
    const env = intent ? snapshot.observations.get(obsKey(dec.symbol, intent)) : undefined;
    const { obs, usable: envelopeUsable } = candidateField(contract, env, market);
    const dimensionScore = dim ? candidateDimensionScore(dim, env, dec.symbol) : null;
    const usable = envelopeUsable && (!dim || dimensionScore !== null);
    fields[contract.fieldId] = usable === envelopeUsable ? obs : { ...obs, present: false };
    if (dim && usable) {
      included[dim] = true;
      candidateScores[dim] = dimensionScore!;
    }
  }

  const anyUsable = SCORE_DIMENSIONS.some((d) => included[d]);
  return {
    // No usable router evidence at all → the candidate honestly abstains rather
    // than scoring on nothing. Retained in the cohort as an abstain row.
    status: anyUsable ? "scored" : "abstained",
    scores: candidateScores,
    included,
    fields,
  };
}

// ── assemble (pure — the reuse point) ────────────────────────────────────────

export interface AssembleInput {
  evaluationId: string;
  market: Market;
  asOf: string;
  marketSessionDate: string;
  universeSnapshotId: string;
  baselinePolicyVersionId: string;
  candidatePolicyVersionId: string;
  strategyVersion: string;
  weights: DimensionRecord<number>;
  scoreThreshold: number;
  priceBasis: string;
  coverageNonInferiorityMargin: number;
  maxAdverseRankDisplacement: number;
  maxScoreDelta?: number;
  decisions: LegacyDecision[];
  snapshot: FrozenObservationSet;
}

/**
 * Assemble a FrozenCohort from recorded decisions + ONE frozen snapshot.
 *
 * PURE and side-effect free. It reads the snapshot for the candidate leg but
 * never resolves — so calling it twice (candidate primary, then legacy
 * reverse-shadow) over the SAME snapshot object triggers zero additional
 * provider work. That is the §4.2 property, made structural: the reuse is not a
 * caching optimization, it is the only way to get evidence into a leg.
 */
export function assembleCohort(input: AssembleInput): FrozenCohort {
  const rows: CohortRow[] = input.decisions.map((dec) => ({
    symbol: dec.symbol,
    shape: dec.shape,
    isHeld: dec.isHeld,
    legacy: buildLegacyObservation(dec, input.market),
    candidate: buildCandidateObservation(dec, input.market, input.snapshot),
  }));

  return {
    evaluationId: input.evaluationId,
    market: input.market,
    asOf: input.asOf,
    marketSessionDate: input.marketSessionDate,
    universeSnapshotId: input.universeSnapshotId,
    baselinePolicyVersionId: input.baselinePolicyVersionId,
    candidatePolicyVersionId: input.candidatePolicyVersionId,
    strategyVersion: input.strategyVersion,
    weights: input.weights,
    scoreThreshold: input.scoreThreshold,
    priceBasis: input.priceBasis,
    rows,
    evaluationCodeVersion: EVALUATION_CODE_VERSION,
    coverageNonInferiorityMargin: input.coverageNonInferiorityMargin,
    maxAdverseRankDisplacement: input.maxAdverseRankDisplacement,
    maxScoreDelta: input.maxScoreDelta ?? 2,
  };
}

// ── impure orchestration (load → resolve once → assemble → evaluate → persist) ─

const DEFAULT_LIMIT = 25;
const DEFAULT_COVERAGE_MARGIN = 0.05;
const DEFAULT_MAX_RANK_DISPLACEMENT = 3;
const DEFAULT_MAX_SCORE_DELTA = 2;

function strategyFingerprint(weights: DimensionRecord<number>, strategyVersion: string): string {
  const s = SCORE_DIMENSIONS.map((d) => `${d}=${weights[d]}`).join(",") + `|${strategyVersion}`;
  return "strat-" + createHash("sha1").update(s).digest("hex").slice(0, 16);
}

/**
 * Load the most recent real production decisions for a market, joined to the
 * research_packet that carries the availability mask + the weights that actually
 * drove the score. Only deterministic-scored rows with a packet are eligible —
 * a legacy leg must be reproducible, not guessed.
 */
export async function loadRecentDecisions(
  market: Market,
  limit: number,
  client?: any,
): Promise<{ decisions: LegacyDecision[]; weights: DimensionRecord<number>; strategyVersion: string }> {
  const svc = client ?? createServiceClient();
  const { data, error } = await svc
    .from("agent_signals")
    .select(
      "symbol, market, analyst_score, direction, is_holding, asset_class, scoring_version, genome_hash, created_at, " +
        "research_packet_id, fundamental_score, technical_score, sentiment_score, macro_score, insider_score",
    )
    .eq("market", market)
    .eq("score_source", "deterministic_v1")
    .not("research_packet_id", "is", null)
    .order("created_at", { ascending: false })
    .limit(limit);
  if (error) throw new Error(`recent decisions load failed: ${error.message}`);

  const rows: any[] = Array.isArray(data) ? data : [];

  // No declared FK between agent_signals and research_packets, so the packet
  // (which carries the availability mask + weights that drove the score) is
  // fetched in a second batched query rather than an embedded join.
  const packetIds = [...new Set(rows.map((r) => r.research_packet_id).filter(Boolean))];
  const packetById = new Map<string, any>();
  if (packetIds.length > 0) {
    const { data: packets, error: pErr } = await svc
      .from("research_packets")
      .select("id, raw_data")
      .in("id", packetIds);
    if (pErr) throw new Error(`research_packets load failed: ${pErr.message}`);
    for (const p of (packets ?? []) as any[]) packetById.set(p.id, p);
  }
  const decisions: LegacyDecision[] = [];
  const seenSymbols = new Set<string>();
  let weights: DimensionRecord<number> | null = null;
  let strategyVersion: string | null = null;
  let selectedFingerprint: string | null = null;

  for (const r of rows) {
    const raw = packetById.get(r.research_packet_id)?.raw_data;
    const pw = raw?._profile_weights;
    const dq = raw?._data_quality;
    if (!pw || !dq) continue; // not reproducible without both — skip honestly
    const rowWeights: DimensionRecord<number> = {
      fundamental: Number(pw.fw), technical: Number(pw.tw), sentiment: Number(pw.sw),
      macro: Number(pw.mw), insider: Number(pw.iw),
    };
    if (!Object.values(rowWeights).every(Number.isFinite)) continue;
    const rowStrategyVersion = String(r.genome_hash || r.scoring_version || "unknown");
    const rowFingerprint = strategyFingerprint(rowWeights, rowStrategyVersion);
    if (selectedFingerprint == null) {
      selectedFingerprint = rowFingerprint;
      weights = rowWeights;
      strategyVersion = rowStrategyVersion;
    }
    if (rowFingerprint !== selectedFingerprint) continue;
    const symbol = String(r.symbol).toUpperCase();
    if (seenSymbols.has(symbol)) continue;
    seenSymbols.add(symbol);
    decisions.push({
      symbol,
      shape: shapeOf(r.asset_class, r.symbol),
      isHeld: r.is_holding === true,
      scores: {
        fundamental: Number(r.fundamental_score),
        technical: Number(r.technical_score),
        sentiment: Number(r.sentiment_score),
        macro: Number(r.macro_score),
        insider: Number(r.insider_score),
      },
      dataQuality: dq,
      recordedAnalystScore: Number(r.analyst_score),
      recordedDirection: String(r.direction ?? ""),
      asOf: r.created_at,
    });
  }

  // Freeze one coherent strategy/weight cohort and exclude duplicates or rows
  // created under a different strategy snapshot.
  if (!weights || !strategyVersion) throw new Error(`no coherent reproducible ${market} strategy cohort found`);
  return { decisions, weights, strategyVersion };
}

/** Map the persisted asset_class to a scorer symbol shape. */
export function shapeOf(assetClass: string | null | undefined, symbol: string): SymbolShape {
  const ac = String(assetClass ?? "").toLowerCase();
  if (ac === "metal") return "metal";
  if (ac === "etf") return "etf";
  // us_equity / india / anything else → equity. (ADR distinction is a future
  // refinement; contractsFor(equity) is the strictly broader field set, so an
  // ADR mis-shaped as equity only over-includes insider — a coverage miss the
  // gate treats conservatively, never a fabricated eligibility.)
  return "equity";
}

export interface CohortBuildReport {
  market: Market;
  evaluationId: string | null;
  asOf: string;
  marketSessionDate: string;
  snapshotId: string;
  symbols: number;
  passed: boolean;
  safetyPass: boolean;
  qualityPass: boolean;
  counts: CohortEvaluation["counts"];
  failures: CohortEvaluation["failures"];
  requiresOwnerReview: number;
  ledgerProof: LedgerProof;
  cohortFingerprint: string;
  /** Per-symbol legacy-score reproduction check (recorded vs replayed). */
  legacyReproduction: { symbol: string; recorded: number; replayed: number | null; matches: boolean }[];
}

export interface LedgerProof {
  primaryRunId: string;
  reverseRunId: string;
  /** Must be zero: the primary is cache-only. */
  primaryProviderCalls: number;
  /** Always 0 — the reverse-shadow leg reuses the frozen set; it cannot resolve. */
  reverseProviderCalls: number;
  primaryCacheHits: number;
  /** (symbol,intent) pairs the reverse leg served from the frozen snapshot. */
  reverseServedFromSnapshot: number;
  /** Anything the reverse leg could NOT serve from the frozen set (must be []). */
  reverseMissing: string[];
  /** Authoritative counts read back from provider_call_ledger by run_id. */
  ledger: {
    primary: { fresh: number; bursts: number; total: number };
    reverse: { fresh: number; bursts: number; total: number };
  } | null;
  holds: boolean;
}

function sessionDateFromBars(snapshot: FrozenObservationSet): string {
  const dates: string[] = [];
  for (const [key, env] of snapshot.observations) {
    if (!key.endsWith("|price.daily_bars") || !env.payload || typeof env.payload !== "object") continue;
    const bars = (env.payload as any).bars;
    const date = Array.isArray(bars) ? String(bars[bars.length - 1]?.date ?? "") : "";
    if (/^\d{4}-\d{2}-\d{2}$/.test(date)) dates.push(date);
  }
  if (dates.length === 0) throw new Error("cohort has no cached daily-bar session date");
  return dates.sort().at(-1)!;
}

/**
 * Confirm the reverse-shadow leg can serve every needed (symbol,intent) from the
 * ONE frozen set — i.e. it needs no provider call. Returns what it served and
 * anything missing (which would mean the snapshot was under-resolved, a build
 * bug — not a licence to re-fetch).
 */
export function verifyReverseShadowReuse(
  snapshot: FrozenObservationSet,
  symbolIntents: Array<{ symbol: string; intent: EvidenceIntent }>,
): { served: number; missing: string[] } {
  const missing: string[] = [];
  let served = 0;
  const seen = new Set<string>();
  for (const si of symbolIntents) {
    const k = obsKey(si.symbol, si.intent);
    if (seen.has(k)) continue;
    seen.add(k);
    if (snapshot.observations.has(k)) served += 1;
    else missing.push(k);
  }
  return { served, missing };
}

/**
 * Build, evaluate, and (unless dryRun) persist one cache-only evaluation.
 * Both legs are structurally unable to call a provider: the primary resolves
 * cache-only and the reverse leg reuses the same frozen map.
 */
export async function buildAndPersistCohort(opts: {
  market: Market;
  limit?: number;
  runId?: string;
  dryRun?: boolean;
  client?: any;
  resolve?: ResolveFn;
}): Promise<CohortBuildReport> {
  const svc = opts.client ?? createServiceClient();
  const limit = opts.limit ?? DEFAULT_LIMIT;
  const stamp = opts.runId ?? `cohort:${opts.market}:${Date.now()}`;
  const primaryRunId = `${stamp}:primary`;
  const reverseRunId = `${stamp}:reverse`;

  const { decisions, weights, strategyVersion } = await loadRecentDecisions(opts.market, limit, svc);
  if (decisions.length === 0) {
    throw new Error(`no reproducible ${opts.market} decisions found (need deterministic_v1 rows with a research_packet)`);
  }

  // Knowledge cutoff = the newest decision's timestamp. Both legs share it.
  const asOf = decisions.reduce((max, d) => (d.asOf > max ? d.asOf : max), decisions[0].asOf);

  // Every (symbol, applicable score-affecting dimension → intent) pair.
  const symbolIntents: Array<{ symbol: string; intent: EvidenceIntent }> = [];
  for (const dec of decisions) {
    for (const contract of contractsFor(opts.market, dec.shape)) {
      const dim = contract.dimension;
      if (dim && DIMENSION_INTENT[dim]) symbolIntents.push({ symbol: dec.symbol, intent: DIMENSION_INTENT[dim].intent });
    }
  }

  // PRIMARY resolve is cache-only. A miss is readiness evidence, not permission
  // for the evaluator to spend quota repairing its own input.
  const activeVersionId = await loadActivePolicyVersion(svc, opts.market);
  const candidateVersionId = await loadCandidatePolicyVersion(svc, opts.market);
  const snapshot = await resolveFrozenObservations({
    market: opts.market, symbolIntents, asOf, runId: primaryRunId,
    policyVersionId: candidateVersionId, resolve: opts.resolve,
  });
  const marketSessionDate = sessionDateFromBars(snapshot);

  // ── REVERSE-SHADOW — REUSE the SAME frozen set. It issues NO resolve, so it
  //    can make no provider call by construction. This is the §4.2 property made
  //    structural, not a caching coincidence: the reverse leg has no path to a
  //    provider, only to the frozen Map. ────────────────────────────────────────
  const reuse = verifyReverseShadowReuse(snapshot, symbolIntents);

  const scoreThreshold = await loadScoreThreshold(svc, opts.market);

  const cohort = assembleCohort({
    evaluationId: `${stamp}`,
    market: opts.market,
    asOf,
    marketSessionDate,
    universeSnapshotId: snapshot.snapshotId,
    baselinePolicyVersionId: activeVersionId,
    candidatePolicyVersionId: candidateVersionId,
    strategyVersion,
    weights,
    scoreThreshold,
    priceBasis: "eod_adjusted",
    coverageNonInferiorityMargin: DEFAULT_COVERAGE_MARGIN,
    maxAdverseRankDisplacement: DEFAULT_MAX_RANK_DISPLACEMENT,
    maxScoreDelta: DEFAULT_MAX_SCORE_DELTA,
    decisions,
    snapshot,
  });

  const evaluation = evaluateCohort(cohort);

  // Legacy-leg self-consistency: the replayed legacy score MUST equal what
  // production recorded (proves we froze the right mask + weights, not a guess).
  const legacyScored = scorePathForReport(cohort);
  const legacyReproduction = decisions.map((d) => {
    const s = legacyScored.get(d.symbol) ?? null;
    return { symbol: d.symbol, recorded: d.recordedAnalystScore, replayed: s, matches: s === d.recordedAnalystScore };
  });

  const ledger = await readLedgerProof(svc, primaryRunId, reverseRunId);
  const ledgerProof: LedgerProof = {
    primaryRunId,
    reverseRunId,
    primaryProviderCalls: snapshot.providerCalls,
    // Zero by construction — the reverse leg reused the frozen set and issued no
    // resolve. The ledger confirms it: no rows are written under reverseRunId.
    reverseProviderCalls: 0,
    primaryCacheHits: snapshot.cacheHits,
    reverseServedFromSnapshot: reuse.served,
    reverseMissing: reuse.missing,
    ledger,
    // Both paths must be provider-call-free.
    holds:
      snapshot.providerCalls === 0 &&
      reuse.missing.length === 0 &&
      ledger !== null && ledger.primary.bursts === 0 &&
      ledger.reverse.bursts === 0 && ledger.reverse.total === 0,
  };

  const reproductionFailures = legacyReproduction.filter((row) => !row.matches);
  const proofFailures = [
    ...(ledgerProof.holds ? [] : [{ code: "ledger_proof_missing" as const, symbol: null, detail: "cache-only proof failed: provider burst, unreadable ledger, or reverse run was not empty" }]),
    ...reproductionFailures.map((row) => ({ code: "legacy_reproduction_failed" as const, symbol: row.symbol, detail: `recorded=${row.recorded}, replayed=${row.replayed}` })),
  ];
  const auditedEvaluation: CohortEvaluation = proofFailures.length === 0
    ? evaluation
    : {
        ...evaluation,
        passed: false,
        safetyPass: false,
        safetyFailures: [...evaluation.safetyFailures, ...proofFailures],
        failures: [...evaluation.failures, ...proofFailures],
      };

  let evaluationId: string | null = null;
  if (!opts.dryRun) {
    const fingerprint = cohortFingerprint(cohort);
    const { data: existing, error: existingError } = await svc
      .from("evidence_policy_evaluations")
      .select("id")
      .eq("market", opts.market)
      .eq("cohort_fingerprint", fingerprint)
      .eq("evaluation_code_version", EVALUATION_CODE_VERSION)
      .maybeSingle();
    if (existingError) throw new Error(`existing evaluation lookup failed: ${existingError.message}`);
    evaluationId = existing?.id ?? await persistEvaluation({
      cohort,
      evaluation: auditedEvaluation,
      strategyFingerprint: strategyFingerprint(weights, strategyVersion),
      callUsage: {
        builder_version: COHORT_BUILDER_VERSION,
        primary_run_id: primaryRunId,
        reverse_run_id: reverseRunId,
        primary_provider_calls: snapshot.providerCalls,
        reverse_provider_calls: 0,
        reverse_served_from_snapshot: reuse.served,
        primary_cache_hits: snapshot.cacheHits,
        ledger_proof_holds: ledgerProof.holds,
      },
      client: svc,
    });
  }

  return {
    market: opts.market,
    evaluationId,
    asOf,
    marketSessionDate,
    snapshotId: snapshot.snapshotId,
    symbols: decisions.length,
    passed: auditedEvaluation.passed,
    safetyPass: auditedEvaluation.safetyPass,
    qualityPass: auditedEvaluation.qualityPass,
    counts: auditedEvaluation.counts,
    failures: auditedEvaluation.failures,
    requiresOwnerReview: auditedEvaluation.requiresOwnerReview.length,
    ledgerProof,
    cohortFingerprint: cohortFingerprint(cohort),
    legacyReproduction,
  };
}

// Replay just the legacy leg's scores for the reproduction check, using the SAME
// production scorer scorePath uses — so a match proves we froze the right mask +
// weights, not a coincidence of a re-implementation.
function scorePathForReport(cohort: FrozenCohort): Map<string, number | null> {
  const out = new Map<string, number | null>();
  for (const row of cohort.rows) {
    if (row.legacy.status !== "scored") { out.set(row.symbol, null); continue; }
    const { score } = computeWeightedAnalystScore(row.legacy.scores, row.legacy.included, cohort.weights);
    out.set(row.symbol, score);
  }
  return out;
}

async function loadActivePolicyVersion(svc: any, market: Market): Promise<string> {
  const { data, error } = await svc
    .from("active_evidence_policy")
    .select("policy_version_id")
    .eq("market", market)
    .maybeSingle();
  if (error || !data?.policy_version_id) {
    throw new Error(`no active evidence policy for ${market}: ${error?.message ?? "missing pointer"}`);
  }
  return data.policy_version_id as string;
}

async function loadCandidatePolicyVersion(svc: any, market: Market): Promise<string> {
  const { data, error } = await svc
    .from("evidence_policy_versions")
    .select("id")
    .eq("market", market)
    .eq("router_enabled", true)
    .order("version", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error || !data?.id) {
    throw new Error(`no inert router-enabled candidate policy for ${market}: ${error?.message ?? "missing candidate"}`);
  }
  return data.id as string;
}

async function loadScoreThreshold(svc: any, market: Market): Promise<number> {
  const { data, error } = await svc
    .from("trading_mandates")
    .select("score_threshold")
    .eq("market", market)
    .maybeSingle();
  const threshold = Number(data?.score_threshold);
  if (error || !Number.isFinite(threshold) || threshold < 0 || threshold > 100) {
    throw new Error(`valid trading mandate score_threshold missing for ${market}: ${error?.message ?? "invalid value"}`);
  }
  return threshold;
}

async function readLedgerProof(
  svc: any,
  primaryRunId: string,
  reverseRunId: string,
): Promise<LedgerProof["ledger"]> {
  try {
    const { data, error } = await svc
      .from("provider_call_ledger")
      .select("run_id, cache_outcome, lease_outcome")
      .in("run_id", [primaryRunId, reverseRunId]);
    if (error) return null;
    const tally = (runId: string) => {
      const rows = (data ?? []).filter((r: any) => r.run_id === runId);
      const fresh = rows.filter((r: any) => r.cache_outcome === "fresh").length;
      // A burst = a row that made REAL provider HTTP work: lease started (then
      // maybe errored) or completed. A "denied" is the pacing lease correctly
      // REFUSING a call (no HTTP made) — that is the protection working, not a
      // burst. "skipped" is a fresh cache hit. So neither counts.
      const bursts = rows.filter((r: any) =>
        r.lease_outcome === "started" || r.lease_outcome === "completed").length;
      return { fresh, bursts, total: rows.length };
    };
    return { primary: tally(primaryRunId), reverse: tally(reverseRunId) };
  } catch {
    return null;
  }
}
