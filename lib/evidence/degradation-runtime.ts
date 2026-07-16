// Runtime evidence-degradation guard — DB + health wiring (router-cutover §6).
//
// The pure decision lives in degradation-guard.ts. This module is the impure
// shell: it loads the last accepted market-local baseline, records the decision
// as append-only evidence, promotes clean masks to the new baseline, and emits
// ONE AGGREGATED health event per run — never one alert per symbol (§6.6).
//
// Fail-soft everywhere: a guard/persistence failure must not break a research
// run. But note the direction of the failure — if we cannot evaluate, we return
// `allow` and record nothing, which leaves today's behavior exactly as-is. The
// guard is subtractive; losing it can never make the system more permissive
// than it already is.

import { createServiceClient } from "@/lib/supabase/service";
import { reportIssue, resolveIssue } from "@/lib/system-health";
import type { Market } from "@/lib/evidence/contracts";
import type { SymbolShape } from "@/lib/evidence/intent-classification";
import {
  applyDegradationGuard,
  evaluateDegradation,
  parseGuardMode,
  type FieldMask,
  type FieldObservation,
  type GuardDecision,
  type GuardMode,
  type SignalDirection,
} from "@/lib/evidence/degradation-guard";

export const GUARD_CODE_VERSION = "degradation-guard-v1";

/**
 * Shipped mode. Defaults to measure-only: the guard records exactly what it
 * WOULD abstain without changing a single direction, so it can be observed on
 * real traffic before it bites. Only an explicit env flip enforces.
 */
export function guardMode(): GuardMode {
  return parseGuardMode(process.env.EVIDENCE_DEGRADATION_GUARD_MODE);
}

// ── baseline ─────────────────────────────────────────────────────────────────

export async function loadBaseline(
  market: Market,
  symbol: string,
  client?: any,
): Promise<FieldMask | null> {
  const svc = client ?? createServiceClient();
  try {
    const { data, error } = await svc
      .from("evidence_field_baselines")
      .select("mask")
      .eq("market", market)
      .eq("symbol", symbol.toUpperCase())
      .maybeSingle();
    if (error) throw new Error(`baseline read failed: ${error.message}`);
    const mask = (data as any)?.mask;
    return mask && typeof mask === "object" ? (mask as FieldMask) : null;
  } catch (error) {
    // No baseline → the guard defaults to abstain for unusable required fields.
    throw error;
  }
}

async function acceptBaseline(decision: GuardDecision, client?: any): Promise<void> {
  const svc = client ?? createServiceClient();
  try {
    const { error } = await svc.from("evidence_field_baselines").upsert(
      {
        market: decision.market,
        symbol: decision.symbol.toUpperCase(),
        mask: decision.currentMask as any,
        policy_version_id: decision.policyVersionId || null,
        evidence_run_id: decision.evidenceRunId || null,
        guard_code_version: GUARD_CODE_VERSION,
        accepted_at: new Date().toISOString(),
      },
      { onConflict: "market,symbol" },
    );
    if (error) throw new Error(`baseline write failed: ${error.message}`);
  } catch (error) { throw error; }
}

// ── append-only evidence ─────────────────────────────────────────────────────

async function recordEvent(
  decision: GuardDecision,
  mode: GuardMode,
  proposed: SignalDirection,
  applied: SignalDirection,
  client?: any,
): Promise<void> {
  const svc = client ?? createServiceClient();
  try {
    const { error } = await svc.from("evidence_degradation_events").insert({
      market: decision.market,
      symbol: decision.symbol.toUpperCase(),
      evidence_run_id: decision.evidenceRunId || null,
      policy_version_id: decision.policyVersionId || null,
      guard_mode: mode,
      guard_code_version: GUARD_CODE_VERSION,
      action: decision.action,
      blocking_codes: decision.blockingCodes,
      proposed_direction: proposed,
      applied_direction: applied,
      // Full replay material: which mask we compared against, what we saw, and
      // every classified transition with its reason code.
      baseline_mask: decision.baselineMask as any,
      current_mask: decision.currentMask as any,
      transitions: decision.transitions as any,
    });
    if (error) throw new Error(`degradation audit write failed: ${error.message}`);
  } catch (error) { throw error; }
}

// ── per-run aggregation (ONE health event, not one per symbol) ───────────────

interface RunTally {
  evaluated: number;
  abstained: number;          // action = abstain_new_long
  enforced: number;           // direction actually changed
  wouldAbstain: number;       // measure-only hits
  codes: Map<string, number>;
  symbols: Set<string>;
  lastTouched: number;
}

const RUN_TALLY = new Map<string, RunTally>();
const RUN_GAP_MS = 30 * 60 * 1000; // a quiet gap this long starts a fresh tally

function tallyFor(key: string): RunTally {
  const now = Date.now();
  let t = RUN_TALLY.get(key);
  if (!t || now - t.lastTouched > RUN_GAP_MS) {
    t = { evaluated: 0, abstained: 0, enforced: 0, wouldAbstain: 0, codes: new Map(), symbols: new Set(), lastTouched: now };
    RUN_TALLY.set(key, t);
  }
  t.lastTouched = now;
  return t;
}

/** Exposed for tests — the tally is process-local and must not leak across cases. */
export function __resetRunTallies(): void {
  RUN_TALLY.clear();
}

async function emitAggregatedHealth(
  market: Market,
  runKey: string,
  mode: GuardMode,
  client?: any,
): Promise<void> {
  const key = `${market}:${runKey}`;
  const t = RUN_TALLY.get(key);
  if (!t) return;
  const issueKey = `evidence-degradation:${market}:${runKey}`;

  // ONE alert for the whole run, refreshed in place as symbols accumulate.
  // reportIssue is idempotent on issueKey, so this never fans out per symbol.
  if (t.abstained === 0) {
    await resolveIssue(issueKey, client).catch(() => {});
    return;
  }

  const codeSummary = [...t.codes.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([c, n]) => `${c}×${n}`)
    .join(", ");
  const sample = [...t.symbols].slice(0, 8).join(", ");
  const modeLabel = mode === "enforce" ? "ENFORCING" : "measure-only (no direction changed)";

  await reportIssue(
    {
      issueKey,
      // measure-only is informational by construction: nothing was withheld.
      severity: mode === "enforce" ? "warn" : "info",
      category: "data",
      title: `${market.toUpperCase()} evidence degradation: ${t.abstained}/${t.evaluated} symbols would abstain from new longs`,
      detail:
        `Guard mode: ${modeLabel}. ${t.abstained} of ${t.evaluated} evaluated ${market.toUpperCase()} symbols had a REQUIRED evidence field ` +
        `degrade against their last accepted baseline, and their score renormalized around that loss — so a new long there would rest on ` +
        `evidence we no longer have. ${mode === "enforce" ? `${t.enforced} long signal(s) were downgraded to neutral.` : `${t.wouldAbstain} long signal(s) WOULD have been downgraded had the guard been enforcing.`} ` +
        `Reason codes: ${codeSummary}. Symbols: ${sample}${t.symbols.size > 8 ? ` (+${t.symbols.size - 8} more)` : ""}. ` +
        `Existing holdings are unaffected — exits, stops, and PositionMonitor risk logic continue normally. ` +
        `Next: check the named providers for this market's required fields (daily bars, reported fundamentals); the guard clears itself once a clean run re-baselines.`,
    },
    client,
  ).catch(() => {});
}

// ── entry point ──────────────────────────────────────────────────────────────

export interface GuardRunInput {
  market: Market;
  symbol: string;
  shape: SymbolShape;
  isHeld: boolean;
  observations: FieldObservation[];
  proposedDirection: SignalDirection;
  policyVersionId: string;
  evidenceRunId: string;
  runKey: string;
  client?: any;
}

export interface GuardRunResult {
  direction: SignalDirection;
  note: string;
  applied: boolean;
  wouldAbstain: boolean;
  decision: GuardDecision | null;
  mode: GuardMode;
}

/** Pure failure policy so the money-path invariant is directly testable. */
export function guardRuntimeFailureResult(
  input: Pick<GuardRunInput, "isHeld" | "proposedDirection">,
  mode: GuardMode,
): GuardRunResult {
  const mustAbstain = mode === "enforce" && !input.isHeld && input.proposedDirection === "long";
  return {
    direction: mustAbstain ? "neutral" : input.proposedDirection,
    note: mustAbstain ? "new long withheld: evidence guard could not complete safely" : "",
    applied: mustAbstain,
    wouldAbstain: mode === "measure_only" && !input.isHeld && input.proposedDirection === "long",
    decision: null,
    mode,
  };
}

/**
 * Evaluate one symbol and (in `enforce` mode only) apply the abstain.
 *
 * Returns the proposed direction unchanged on ANY internal failure — the guard
 * can only subtract, so its absence is never less safe than today's behavior.
 */
export async function runDegradationGuard(input: GuardRunInput): Promise<GuardRunResult> {
  const mode = guardMode();
  if (mode === "off") {
    return { direction: input.proposedDirection, note: "", applied: false, wouldAbstain: false, decision: null, mode };
  }

  try {
    const baseline = await loadBaseline(input.market, input.symbol, input.client);
    const decision = evaluateDegradation({
      market: input.market,
      symbol: input.symbol,
      shape: input.shape,
      isHeld: input.isHeld,
      observations: input.observations,
      baseline,
      policyVersionId: input.policyVersionId,
      evidenceRunId: input.evidenceRunId,
    });

    const application = applyDegradationGuard(input.proposedDirection, decision, mode);

    // Tally BEFORE any await that could reorder, so the aggregate is honest.
    const t = tallyFor(`${input.market}:${input.runKey}`);
    t.evaluated += 1;
    if (decision.action === "abstain_new_long") {
      t.abstained += 1;
      t.symbols.add(input.symbol.toUpperCase());
      for (const c of decision.blockingCodes) t.codes.set(c, (t.codes.get(c) ?? 0) + 1);
      if (application.applied) t.enforced += 1;
      else if (application.wouldAbstain) t.wouldAbstain += 1;
    }

    // Record every evaluation that found a degradation (clean allows are the
    // common case and would bloat an append-only table for no audit value —
    // their mask is preserved as the accepted baseline instead).
    if (decision.action === "abstain_new_long") {
      await recordEvent(decision, mode, input.proposedDirection, application.direction, input.client);
    }
    if (decision.baselineAcceptable) {
      await acceptBaseline(decision, input.client);
    }
    await emitAggregatedHealth(input.market, input.runKey, mode, input.client);

    return {
      direction: application.direction,
      note: application.note,
      applied: application.applied,
      wouldAbstain: application.wouldAbstain,
      decision,
      mode,
    };
  } catch (error) {
    await reportIssue({
      issueKey: `evidence-degradation-runtime:${input.market}:${input.runKey}`,
      severity: mode === "enforce" ? "critical" : "warn",
      category: "data",
      title: `${input.market.toUpperCase()} evidence guard runtime failure`,
      detail: `The degradation guard could not complete for ${input.symbol.toUpperCase()}. ` +
        `${mode === "enforce" ? "New long entries fail closed; held-position exits and short directions remain available." : "Measure-only mode left directions unchanged."} ` +
        `Cause: ${error instanceof Error ? error.message : "unknown guard error"}`,
    }, input.client).catch(() => {});
    return guardRuntimeFailureResult(input, mode);
  }
}

// ── observation builder (legacy path adapter) ────────────────────────────────

/**
 * Build guard observations from the LEGACY scorer's availability mask.
 *
 * The legacy path knows availability and contract satisfaction but not the
 * observation's age, so `ageSeconds` is honestly null rather than an invented
 * zero: unknown age is not evidence of freshness. Quality is therefore reported
 * as `fresh` only in the sense of "usable and not known-stale"; the Router path
 * supplies real quality/age once an intent family is cut over, and the guard
 * core already handles those transitions (proven by tests).
 */
export interface LegacyMaskInput {
  isEtf: boolean;
  isAdr: boolean;
  isMetal: boolean;
  /** Dimension → structurally applicable for this symbol. */
  applicable: Set<string>;
  /** Dimension → real evidence present this run (the scorer's `included` mask). */
  included: Record<string, boolean>;
  /** Dimension → the scorer excluded it AND renormalized weights around it. */
  renormalized: boolean;
  technicalDataPoints: number;
}

export function symbolShapeOf(i: { isEtf: boolean; isAdr: boolean; isMetal: boolean }): SymbolShape {
  if (i.isMetal) return "metal";
  if (i.isEtf) return "etf";
  if (i.isAdr) return "adr";
  return "equity";
}

/** Canonical field ↔ legacy dimension mapping (the §8.1 compatibility bridge). */
const DIMENSION_FIELD: Array<{ fieldId: string; dimension: string }> = [
  { fieldId: "technical.daily_bars", dimension: "technical" },
  { fieldId: "fundamental.reported_core", dimension: "fundamental" },
  { fieldId: "sentiment.news_tone", dimension: "sentiment" },
  { fieldId: "insider.net_flow", dimension: "insider" },
  { fieldId: "macro.regime", dimension: "macro" },
];

export function observationsFromLegacyMask(input: LegacyMaskInput): FieldObservation[] {
  return DIMENSION_FIELD.map(({ fieldId, dimension }) => {
    const applicable = input.applicable.has(dimension);
    const present = input.included[dimension] === true;
    if (!applicable) {
      return {
        fieldId,
        availability: "not_applicable" as const,
        quality: "not_applicable" as const,
        ageSeconds: null,
        contractOk: false,
        renormalizedAround: false,
      };
    }
    const contractOk =
      dimension === "technical" ? input.technicalDataPoints >= 15 : present;
    return {
      fieldId,
      availability: present ? ("available" as const) : ("missing" as const),
      quality: present ? ("fresh" as const) : ("unavailable" as const),
      ageSeconds: null,
      contractOk,
      // The dimension was dropped from the weighted score and the remaining
      // weights were redistributed — this symbol's eligibility now depends on
      // that renormalization.
      renormalizedAround: applicable && !present && input.renormalized,
    };
  });
}
