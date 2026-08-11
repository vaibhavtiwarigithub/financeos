// Conditional horizon extension — PURE DECISION CORE. Measure-only.
//
// WHY THIS EXISTS
// 68-73% of every closed paper lot exits on the unconditional time stop, which
// fires when ageDays > horizonDays with no reference to P&L, trend or score. A
// position up 18% with a rising score is closed on the same day as one flat at
// zero. But the fix is NOT "hold everything longer": production time stops split
// sharply by market — India's clock has been harvesting profitable positions
// while US time stops mostly clear weak ones. Extending globally would preserve
// US losers to rescue India winners.
//
// So this decides per position, at a checkpoint, under conjunctive conditions.
//
// SAFETY MODEL (mirrors lib/evidence/degradation-guard.ts):
//  - Strictly ADDITIVE to hold time and nothing else. It can only ever turn
//    "close now" into "hold one more day", bounded by a hard ceiling. It cannot
//    open, size, re-enter, or suppress a stop/target/exit.
//  - FAIL-CLOSED on missing evidence. Any required input that is null means DO
//    NOT extend. Absent evidence must never buy more holding time — that is the
//    same rule the degradation guard applies to entries.
//  - Deterministic. No LLM, ever.
//
// NOTHING CONSUMES THIS YET. It is wired only to a shadow recorder.

export type Market = "us" | "india";

export interface ExtensionInputs {
  market: Market;
  /** Market days held so far. */
  ageDays: number;
  /** The horizon the live time stop would fire on (currently mandate target_hold_days). */
  horizonDays: number;
  /** Hard ceiling — mandate max_hold_days. Never extended past this. */
  ceilingDays: number;

  /** Freshest score for the symbol, and whether it is recent enough to trust. */
  score: number | null;
  scoreFresh: boolean;
  /** Score at (or nearest before) the previous checkpoint, for stable-or-improving. */
  priorScore: number | null;
  /** ENTRY threshold, deliberately not the lower exit threshold. */
  entryThreshold: number;

  /** Unrealized return %, e.g. 3.2 for +3.2%. */
  unrealizedPct: number | null;
  /** Position return minus benchmark return over the same hold, in points. */
  benchmarkRelPct: number | null;

  priceAboveEma20: boolean | null;
  breakdownVeto: boolean | null;
  /** True when an earnings event sits inside the extension window. */
  earningsVeto: boolean | null;
  /** False when the evidence behind the score is degraded/thin. */
  dataQualityOk: boolean | null;
}

/** Bounded reason codes — no free text, so the shadow ledger stays groupable. */
export type ExtensionReason =
  | "extended"
  | "not_at_checkpoint"
  | "ceiling_reached"
  | "score_missing"
  | "score_stale"
  | "score_below_entry_threshold"
  | "score_deteriorating"
  | "unrealized_not_positive"
  | "lagging_benchmark"
  | "trend_unhealthy"
  | "breakdown_veto"
  | "earnings_veto"
  | "data_quality_veto"
  | "evidence_missing";

export interface ExtensionVerdict {
  extend: boolean;
  reason: ExtensionReason;
  /** Every condition that failed, so a shadow row shows WHY, not just no. */
  failed: ExtensionReason[];
  /** Day the position would be closed if nothing changes. */
  effectiveExitDay: number;
}

/**
 * Score must not be deteriorating. A tolerance of 2 points treats ordinary
 * day-to-day score noise as "stable" rather than as decay; anything worse than
 * that is a real downtrend and blocks the extension.
 */
export const SCORE_DECAY_TOLERANCE = 2;

export function decideExtension(i: ExtensionInputs): ExtensionVerdict {
  const noExtend = (reason: ExtensionReason, failed: ExtensionReason[] = [reason]): ExtensionVerdict => ({
    extend: false, reason, failed, effectiveExitDay: Math.min(i.horizonDays, i.ceilingDays),
  });

  // Not yet at the decision point — the normal time stop has not come due.
  if (i.ageDays < i.horizonDays) {
    return { extend: false, reason: "not_at_checkpoint", failed: [], effectiveExitDay: i.horizonDays };
  }

  // Hard ceiling. Checked BEFORE any condition so no combination of healthy
  // signals can push a position past the mandate's maximum hold.
  if (i.ageDays >= i.ceilingDays) return noExtend("ceiling_reached");

  const failed: ExtensionReason[] = [];

  // ── Score conditions ──────────────────────────────────────────────────────
  if (i.score == null) failed.push("score_missing");
  else if (!i.scoreFresh) failed.push("score_stale");
  else {
    // Deliberately the ENTRY threshold: continuing to hold is a fresh assertion
    // that this position still deserves capital, so it must clear the bar a NEW
    // entry would, not the lower bar that merely avoids an exit.
    if (i.score < i.entryThreshold) failed.push("score_below_entry_threshold");
    // Stable or improving. A high but decaying score must not extend a position.
    if (i.priorScore == null) failed.push("evidence_missing");
    else if (i.score < i.priorScore - SCORE_DECAY_TOLERANCE) failed.push("score_deteriorating");
  }

  // ── Performance conditions ────────────────────────────────────────────────
  if (i.unrealizedPct == null) failed.push("evidence_missing");
  else if (i.unrealizedPct <= 0) failed.push("unrealized_not_positive");

  if (i.benchmarkRelPct == null) failed.push("evidence_missing");
  else if (i.benchmarkRelPct < 0) failed.push("lagging_benchmark");

  // ── Trend / veto conditions ───────────────────────────────────────────────
  if (i.priceAboveEma20 == null) failed.push("evidence_missing");
  else if (!i.priceAboveEma20) failed.push("trend_unhealthy");

  if (i.breakdownVeto == null) failed.push("evidence_missing");
  else if (i.breakdownVeto) failed.push("breakdown_veto");

  if (i.earningsVeto == null) failed.push("evidence_missing");
  else if (i.earningsVeto) failed.push("earnings_veto");

  if (i.dataQualityOk == null) failed.push("evidence_missing");
  else if (!i.dataQualityOk) failed.push("data_quality_veto");

  if (failed.length) {
    const unique = [...new Set(failed)];
    return { extend: false, reason: unique[0], failed: unique, effectiveExitDay: Math.min(i.horizonDays, i.ceilingDays) };
  }

  // Extend by exactly ONE day and re-evaluate tomorrow. Granting the whole
  // remaining window at once would let a position that turns on day 11 coast to
  // day 15 on a stale decision.
  return {
    extend: true,
    reason: "extended",
    failed: [],
    effectiveExitDay: Math.min(i.ageDays + 1, i.ceilingDays),
  };
}
