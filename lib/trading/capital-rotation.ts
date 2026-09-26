import { DEFAULT_LIMITS, type BookPosition, type PortfolioLimits } from "@/lib/portfolio/constructor";
import { projectPaperExitPlan, type PaperExitPlanState } from "@/lib/trading/paper-exit-plan";
import { isPaperScoreFresh } from "@/lib/trading/paper-exit-policy";
import {
  assessRotationP1Readiness,
  estimateRotationFrictionPct,
  measureCandidatePostSwapCorrelation,
  rotationTurnoverNotional,
  type RotationP1Readiness,
  type RotationReturnRow,
} from "@/lib/trading/rotation-readiness";
import { fetchAllRows } from "@/lib/supabase/paginate";
import { replacementCapacity } from "./rotation-capacity";
import { isEntryCandidateLong, isHoldingReview } from "@/lib/learning/entry-cohort";
import {
  hasExactPaperTaxLot,
  summarizeRotationScoreEdgeEvidence,
  type RotationScoreEdgeEvidence,
  type RotationScoreOutcome,
} from "@/lib/trading/rotation-evidence";

export interface RotationCandidate {
  signalId: string;
  symbol: string;
  market: "us" | "india";
  currency: "USD" | "INR";
  score: number;
  targetNotional: number;
  cash: number;
  sector?: string | null;
  dailyVol?: number | null;
  fillPrice?: number;
}

export interface RotationHolding {
  id: string;
  symbol: string;
  market: "us" | "india";
  qty: number;
  avgCost: number;
  currentPrice: number;
  openedAt: string | null;
  priceTarget: number | null;
  stopLoss: number | null;
  exitReason: string | null;
  score: number | null;
  scoreCreatedAt?: string | null;
  exitPlanState?: PaperExitPlanState;
  priceFresh?: boolean;
}

export interface RotationConfig {
  shadowEnabled: boolean;
  marginScore: number;
  minHoldingDays: number;
  exitScoreThreshold: number;
  nearTargetPct: number;
  nearStopPct: number;
}

export interface RotationEvaluation {
  eligible: boolean;
  status: "planned" | "rejected" | "evaluated";
  reason: string;
  source: RotationHolding | null;
  scoreEdge: number | null;
  sellNotional: number | null;
  buyNotional: number;
  gates: Record<string, unknown>;
}

export function countDistinctPriorRotationRuns(rows: Array<{ audit_json?: unknown }>, currentRunId: string): number {
  return new Set(rows
    .map(row => {
      const audit = row.audit_json && typeof row.audit_json === "object"
        ? row.audit_json as Record<string, unknown>
        : null;
      return String(audit?.run_id ?? "");
    })
    .filter(id => id.length > 0 && id !== currentRunId)).size;
}

function daysHeld(openedAt: string | null, now = new Date()): number | null {
  if (!openedAt) return null;
  const t = new Date(openedAt).getTime();
  if (!Number.isFinite(t)) return null;
  return Math.floor((now.getTime() - t) / 86400000);
}

function finitePositive(n: unknown): number | null {
  const x = Number(n);
  return Number.isFinite(x) && x > 0 ? x : null;
}

function holdingNotional(h: RotationHolding): number {
  const price = finitePositive(h.currentPrice) ?? finitePositive(h.avgCost) ?? 0;
  return Math.max(0, Number(h.qty) * price);
}

function sourceRejectReason(h: RotationHolding, cfg: RotationConfig, now: Date): string | null {
  if (h.exitReason) return "position_has_exit_reason";
  if (h.exitPlanState && h.exitPlanState !== "hold") return `position_exit_due:${h.exitPlanState}`;
  if (h.priceFresh === false) return "missing_fresh_price";
  if (h.score == null || !Number.isFinite(h.score)) return "missing_fresh_score";
  if (h.score < cfg.exitScoreThreshold) return "below_exit_threshold";
  const held = daysHeld(h.openedAt, now);
  if (held == null || held < cfg.minHoldingDays) return "min_holding_days";
  const price = finitePositive(h.currentPrice);
  if (!price) return "missing_price";
  if (h.stopLoss != null && price <= h.stopLoss) return "stop_exit_due";
  if (h.priceTarget != null && h.priceTarget > 0 && price >= h.priceTarget) return "target_exit_due";
  if (h.priceTarget != null && h.priceTarget > 0) {
    const distanceToTarget = (h.priceTarget - price) / price;
    if (distanceToTarget >= 0 && distanceToTarget <= cfg.nearTargetPct) return "near_target";
  }
  if (h.stopLoss != null && h.stopLoss > 0) {
    const distanceToStop = (price - h.stopLoss) / price;
    if (distanceToStop >= 0 && distanceToStop <= cfg.nearStopPct) return "near_stop";
  }
  return null;
}

export function evaluateCapitalRotationShadow(args: {
  candidate: RotationCandidate;
  holdings: RotationHolding[];
  config: RotationConfig;
  now?: Date;
  sizeForSource?: (source: RotationHolding) => { buyNotional: number; reason: string | null; adjustments?: string[] };
}): RotationEvaluation {
  const now = args.now ?? new Date();
  const candidate = args.candidate;
  const cfg = args.config;
  const gates: Record<string, unknown> = {
    shadow_enabled: cfg.shadowEnabled,
    same_market_currency: true,
    candidate_blocked_only_by_cash: candidate.targetNotional > candidate.cash,
  };

  if (!cfg.shadowEnabled) {
    return { eligible: false, status: "rejected", reason: "rotation_shadow_disabled", source: null, scoreEdge: null, sellNotional: null, buyNotional: candidate.targetNotional, gates };
  }
  if (!Number.isFinite(candidate.score) || candidate.score <= 0) {
    return { eligible: false, status: "rejected", reason: "candidate_score_missing", source: null, scoreEdge: null, sellNotional: null, buyNotional: candidate.targetNotional, gates };
  }

  const rejectCounts: Record<string, number> = {};
  const sellable = args.holdings
    .filter((h) => h.market === candidate.market)
    .map((h) => {
      const reject = h.symbol.trim().toUpperCase() === candidate.symbol.trim().toUpperCase()
        ? "candidate_already_held"
        : sourceRejectReason(h, cfg, now);
      if (reject) rejectCounts[reject] = (rejectCounts[reject] ?? 0) + 1;
      return { holding: h, reject };
    })
    .filter((x): x is { holding: RotationHolding; reject: null } => x.reject == null)
    .map((x) => x.holding);

  gates.source_reject_counts = rejectCounts;
  gates.sellable_holdings = sellable.length;

  if (sellable.length === 0) {
    return { eligible: false, status: "rejected", reason: "no_sellable_holding", source: null, scoreEdge: null, sellNotional: null, buyNotional: candidate.targetNotional, gates };
  }

  sellable.sort((a, b) => (a.score ?? 101) - (b.score ?? 101));
  const considered: Array<{ symbol: string; buyNotional: number; reason: string | null }> = [];
  let source = sellable[0];
  let buyNotional = candidate.targetNotional;
  if (args.sizeForSource) {
    let feasible = false;
    for (const holding of sellable) {
      const sizing = args.sizeForSource(holding);
      considered.push({ symbol: holding.symbol, ...sizing });
      if (!sizing.reason && Number.isFinite(sizing.buyNotional) && sizing.buyNotional > 0
        && sizing.buyNotional <= candidate.targetNotional + 1e-8) {
        source = holding; buyNotional = sizing.buyNotional; feasible = true; break;
      }
    }
    gates.replacement_capacity = considered;
    if (!feasible) return { eligible: false, status: "rejected", reason: "no_feasible_replacement", source: null, scoreEdge: null, sellNotional: null, buyNotional: candidate.targetNotional, gates };
  }
  const scoreEdge = candidate.score - (source.score ?? 0);
  const sellNotional = holdingNotional(source);
  gates.score_edge = scoreEdge;
  gates.rotation_margin_score = cfg.marginScore;
  gates.sell_notional_covers_buy = sellNotional + candidate.cash >= buyNotional;

  if (scoreEdge < cfg.marginScore) {
    return { eligible: false, status: "rejected", reason: "score_edge_below_margin", source, scoreEdge, sellNotional, buyNotional, gates };
  }
  if (sellNotional + candidate.cash < buyNotional) {
    return { eligible: false, status: "rejected", reason: "source_does_not_fund_candidate", source, scoreEdge, sellNotional, buyNotional: candidate.targetNotional, gates };
  }

  return {
    eligible: true,
    status: "planned",
    reason: "shadow_rotation_candidate",
    source,
    scoreEdge,
    sellNotional,
    buyNotional,
    gates,
  };
}

async function latestScoresBySymbol(supabase: any, market: "us" | "india", symbols: string[]): Promise<Map<string, { score: number; createdAt: string }>> {
  const out = new Map<string, { score: number; createdAt: string }>();
  if (symbols.length === 0) return out;
  const since = new Date(Date.now() - 7 * 86400000).toISOString();
  const { data, error } = await supabase
    .from("agent_signals")
    .select("symbol, analyst_score, created_at")
    .eq("market", market)
    .eq("session_validated", true)
    .in("symbol", symbols)
    .gte("created_at", since)
    .order("created_at", { ascending: false })
    .limit(200);
  if (error) throw new Error(`rotation score query failed: ${error.message}`);
  for (const row of (data ?? []) as any[]) {
    const sym = String(row.symbol ?? "");
    if (!sym || out.has(sym)) continue;
    const score = Number(row.analyst_score);
    if (Number.isFinite(score) && row.created_at) out.set(sym, { score, createdAt: String(row.created_at) });
  }
  return out;
}

async function loadRotationScoreEdgeEvidence(supabase: any, args: {
  market: "us" | "india";
  minScoreEdge: number;
  horizonDays: number;
}): Promise<RotationScoreEdgeEvidence> {
  const since = new Date(Date.now() - 400 * 86400000).toISOString();
  const rows = await fetchAllRows((from, to) => supabase
    .from("decision_observations")
    .select("ts,symbol,analyst_score,entry_eligible,direction,decision_context,discovery_source,observation_labels!inner(horizon_days,fwd_return)")
    .eq("market", args.market)
    .gte("ts", since)
    .eq("observation_labels.horizon_days", args.horizonDays)
    .order("ts", { ascending: true }).order("id", { ascending: true })
    .range(from, to), "rotation score-edge evidence");
  const outcomes: RotationScoreOutcome[] = [];
  for (const row of rows as any[]) {
    const labels = Array.isArray(row.observation_labels) ? row.observation_labels : [row.observation_labels];
    const label = labels.find((item: any) => Number(item?.horizon_days) === args.horizonDays);
    if (label?.fwd_return == null || row.analyst_score == null || !row.ts) continue;
    const candidate = isEntryCandidateLong({
      entryEligible: row.entry_eligible,
      direction: row.direction,
      decisionContext: row.decision_context,
      discoverySource: row.discovery_source,
    });
    // BUG FIXED 2026-09-22: this used to check row.decision_context ===
    // "holding_review" directly, skipping the discoverySource fallback that
    // isEntryCandidateLong (above) already applies. Every legacy row before
    // decision_context started being populated has decision_context=null and
    // discovery_source='holding'/'india_holding' instead -- resolveDecisionContext
    // handles that fallback, but this literal check never did, so ZERO rows ever
    // classified as "holding" and the candidate/holding pairing loop in
    // summarizeRotationScoreEdgeEvidence always ran over an empty holdings set.
    // Reproduced directly against production: 538 classified rows, 538
    // candidates, 0 holdings, before this fix. That's the reason
    // score_to_return_mapping has read pairCount=0 for two months of shadow
    // running on both markets, keeping P1 readiness permanently blocked.
    const holding = isHoldingReview({ decisionContext: row.decision_context, discoverySource: row.discovery_source });
    if (!candidate && !holding) continue;
    outcomes.push({
      sessionDate: String(row.ts).slice(0, 10), observedAt: String(row.ts), symbol: String(row.symbol ?? ""),
      role: candidate ? "candidate" : "holding", score: Number(row.analyst_score), forwardReturn: Number(label.fwd_return),
    });
  }
  return summarizeRotationScoreEdgeEvidence(outcomes, {
    minScoreEdge: args.minScoreEdge,
    horizonDays: args.horizonDays,
    requiredIndependentSessions: 20,
  });
}

/** The return RPC can exceed PostgREST's 1,000-row response cap with 15 names. */
export async function loadRotationReturnCohort(
  supabase: any, market: "us" | "india", symbols: string[], since: string,
): Promise<RotationReturnRow[]> {
  return fetchAllRows<RotationReturnRow>((from, to) => supabase
    .rpc("get_rotation_return_cohort", { p_market: market, p_symbols: symbols, p_since: since })
    .order("symbol", { ascending: true })
    .order("session_date", { ascending: true })
    .range(from, to), "rotation return cohort");
}

export interface RotationShadowRecord {
  evaluation: RotationEvaluation;
  readiness: RotationP1Readiness;
  scoreEdgeEvidence: RotationScoreEdgeEvidence;
  evaluatedAt: string;
  plan: { sourceId: string; sourceQty: number; sourcePrice: number; sourceScore: number | null;
    candidateSignalId: string; buyNotional: number } | null;
}

export async function recordCapitalRotationShadow(supabase: any, args: {
  runId: string | null;
  candidate: RotationCandidate;
  scoreThreshold: number;
  minHoldingDays: number;
  resolvedHorizonDays: number;
  maxSignalAgeSessions: number;
  exitHysteresis: number;
  portfolioNav: number;
  book: BookPosition[];
  portfolioLimits?: PortfolioLimits;
  existingPositionsPolicy: "grandfather" | "apply";
  maxPerSector?: number;
}) {
  const candidate = args.candidate;
  const { data: cfgRow, error: cfgError } = await supabase
    .from("rotation_config")
    .select("rotation_shadow_enabled, rotation_margin_score, rotation_persistence_runs")
    .eq("market", candidate.market)
    .eq("book_type", "paper")
    .maybeSingle();
  if (cfgError) throw new Error(`rotation config query failed: ${cfgError.message}`);

  const { data: positions, error: positionsError } = await supabase
    .from("paper_positions")
    .select("id, symbol, market, qty, avg_cost, current_price, opened_at, updated_at, price_target, stop_loss, exit_reason, resolved_horizon_days")
    .eq("market", candidate.market)
    .eq("position_role", "alpha");
  if (positionsError) throw new Error(`rotation position query failed: ${positionsError.message}`);

  const symbols = (positions ?? []).map((p: any) => String(p.symbol)).filter(Boolean);
  const scores = await latestScoresBySymbol(supabase, candidate.market, symbols);
  const now = new Date();
  const holdings: RotationHolding[] = (positions ?? []).map((p: any) => {
    const score = scores.get(String(p.symbol));
    const exitPlan = projectPaperExitPlan({
      position: p,
      signal: score ? { analyst_score: score.score, created_at: score.createdAt } : null,
      entryThreshold: args.scoreThreshold,
      hysteresis: args.exitHysteresis,
      maxScoreAgeSessions: args.maxSignalAgeSessions,
      horizonDays: args.existingPositionsPolicy === "apply"
        ? args.resolvedHorizonDays
        : Number(p.resolved_horizon_days) || args.resolvedHorizonDays,
      horizonSource: args.existingPositionsPolicy !== "apply" && Number(p.resolved_horizon_days) > 0 ? "entry" : "user",
      now,
    });
    return {
      id: String(p.id), symbol: String(p.symbol), market: candidate.market,
      qty: Number(p.qty ?? 0), avgCost: Number(p.avg_cost ?? 0),
      currentPrice: Number(p.current_price ?? 0), openedAt: p.opened_at ?? null,
      priceTarget: p.price_target == null ? null : Number(p.price_target),
      stopLoss: p.stop_loss == null ? null : Number(p.stop_loss), exitReason: p.exit_reason ?? null,
      score: score?.score ?? null, scoreCreatedAt: score?.createdAt ?? null, exitPlanState: exitPlan.state,
      priceFresh: isPaperScoreFresh(p.updated_at, now, candidate.market, 1),
    };
  });

  const evaluation = evaluateCapitalRotationShadow({
    candidate,
    holdings,
    sizeForSource: source => replacementCapacity({
      book: args.book, sourceSymbol: source.symbol, sellNotional: holdingNotional(source),
      symbol: candidate.symbol, market: candidate.market, sector: candidate.sector ?? null,
      dailyVol: candidate.dailyVol ?? null, intendedNotional: candidate.targetNotional,
      nav: args.portfolioNav, cash: candidate.cash, fillPrice: candidate.fillPrice ?? Number.NaN,
      limits: args.portfolioLimits ?? DEFAULT_LIMITS, maxPerSector: args.maxPerSector ?? 4,
    }),
    config: {
      shadowEnabled: (cfgRow as any)?.rotation_shadow_enabled !== false,
      marginScore: Number((cfgRow as any)?.rotation_margin_score ?? 12),
      minHoldingDays: args.minHoldingDays,
      exitScoreThreshold: args.scoreThreshold - 10,
      nearTargetPct: 0.03,
      nearStopPct: 0.03,
    },
  });

  const limits = args.portfolioLimits ?? DEFAULT_LIMITS;
  const sourceSymbol = evaluation.source?.symbol ?? null;
  const postSwapBook = sourceSymbol
    ? args.book.filter(position => position.symbol.toUpperCase() !== sourceSymbol.toUpperCase())
    : args.book;
  // Capacity sizing already applied the stacked-sector haircut once. Repeating
  // that sizing operation would shrink the plan again; use its verified result.
  const postSwapAllowed = sourceSymbol ? (evaluation.gates.replacement_capacity as Array<{ symbol: string; reason: string | null }> | undefined)
    ?.some(row => row.symbol === sourceSymbol && row.reason == null) ?? false : null;

  const symbolsAfterSwap = postSwapBook.map(position => position.symbol);
  const returnCutoff = new Date(Date.now() - 100 * 86400000).toISOString().slice(0, 10);
  const returnRows = await loadRotationReturnCohort(supabase, candidate.market,
    [...new Set([candidate.symbol, ...symbolsAfterSwap])], returnCutoff);
  const correlation = measureCandidatePostSwapCorrelation(returnRows, candidate.symbol, symbolsAfterSwap);
  const correlationAllowed = correlation.status === "ok" && correlation.maxAbsCorrelation != null
    ? correlation.maxAbsCorrelation <= limits.maxAvgPairwiseCorr
    : null;
  const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString();
  const [mandateResult, turnoverResult, persistenceResult, lotFillsResult, lotRowsResult, scoreEdgeEvidence] = await Promise.all([
    supabase.from("investment_mandates").select("turnover_budget_monthly, tax_sensitivity")
      .eq("market", candidate.market).eq("active", true).order("created_at", { ascending: false }).limit(1).maybeSingle(),
    supabase.from("rotation_events").select("status,sell_notional,buy_notional", { count: "exact" }).eq("market", candidate.market)
      .eq("book_type", "paper").eq("status", "paper_executed").gte("created_at", monthStart).limit(1000),
    supabase.from("rotation_events").select("audit_json").eq("market", candidate.market)
      .eq("candidate_symbol", candidate.symbol).eq("status", "planned").gte("created_at", new Date(Date.now() - 4 * 86400000).toISOString()),
    evaluation.source?.openedAt
      ? supabase.from("paper_order_events").select("id,symbol,created_at,qty,fill_price,fill_status", { count: "exact" })
        .eq("market", candidate.market).eq("symbol", evaluation.source.symbol).eq("event_type", "fill").eq("side", "buy")
        .gte("created_at", new Date(new Date(evaluation.source.openedAt).getTime() - 60_000).toISOString()).limit(20)
      : Promise.resolve({ data: [], count: 0, error: null }),
    evaluation.source?.openedAt
      ? supabase.from("paper_trades").select("paper_event_id,qty,fill_price,closed_at,fill_status", { count: "exact" })
        .eq("market", candidate.market).eq("symbol", evaluation.source.symbol).eq("order_side", "buy")
        .gte("executed_at", new Date(new Date(evaluation.source.openedAt).getTime() - 60_000).toISOString()).limit(30)
      : Promise.resolve({ data: [], count: 0, error: null }),
    loadRotationScoreEdgeEvidence(supabase, {
      market: candidate.market,
      minScoreEdge: Number((cfgRow as any)?.rotation_margin_score ?? 12),
      horizonDays: args.resolvedHorizonDays,
    }),
  ]);
  if (mandateResult.error) throw new Error(`rotation mandate query failed: ${mandateResult.error.message}`);
  if (turnoverResult.error) throw new Error(`rotation turnover query failed: ${turnoverResult.error.message}`);
  if ((turnoverResult.count ?? 0) > (turnoverResult.data?.length ?? 0)) throw new Error(`rotation turnover cohort truncated: ${turnoverResult.data?.length ?? 0}/${turnoverResult.count}`);
  if (persistenceResult.error) throw new Error(`rotation persistence query failed: ${persistenceResult.error.message}`);
  if (lotFillsResult.error) throw new Error(`rotation tax-lot query failed: ${lotFillsResult.error.message}`);
  if ((lotFillsResult.count ?? 0) > (lotFillsResult.data?.length ?? 0)) throw new Error(`rotation tax-lot cohort truncated: ${lotFillsResult.data?.length ?? 0}/${lotFillsResult.count}`);
  if (lotRowsResult.error) throw new Error(`rotation paper-lot query failed: ${lotRowsResult.error.message}`);
  if ((lotRowsResult.count ?? 0) > (lotRowsResult.data?.length ?? 0)) throw new Error(`rotation paper-lot cohort truncated: ${lotRowsResult.data?.length ?? 0}/${lotRowsResult.count}`);
  const monthlyTurnover = rotationTurnoverNotional(turnoverResult.data ?? []);
  const proposedTurnover = (evaluation.sellNotional ?? 0) + evaluation.buyNotional;
  const persistenceRequiredRuns = Math.max(0, Number((cfgRow as any)?.rotation_persistence_runs ?? 2) - 1);
  const persistencePriorRuns = countDistinctPriorRotationRuns(persistenceResult.data ?? [], args.runId ?? "manual");
  const frictionPct = evaluation.sellNotional == null ? null : estimateRotationFrictionPct(evaluation.sellNotional, evaluation.buyNotional);
  const exactLots = hasExactPaperTaxLot(evaluation.source ? {
    symbol: evaluation.source.symbol, openedAt: evaluation.source.openedAt,
    qty: evaluation.source.qty, avgCost: evaluation.source.avgCost,
  } : null, (lotFillsResult.data ?? []).map((row: any) => ({
    id: Number(row.id), symbol: String(row.symbol ?? ""), createdAt: String(row.created_at ?? ""), qty: Number(row.qty),
    fillPrice: Number(row.fill_price), fillStatus: row.fill_status == null ? null : String(row.fill_status),
  })), (lotRowsResult.data ?? []).map((row: any) => ({
    paperEventId: row.paper_event_id == null ? null : Number(row.paper_event_id),
    qty: Number(row.qty), fillPrice: Number(row.fill_price),
    closedAt: row.closed_at == null ? null : String(row.closed_at),
    fillStatus: row.fill_status == null ? null : String(row.fill_status),
  })));
  const readiness = assessRotationP1Readiness({
    persistencePriorRuns,
    persistenceRequiredRuns,
    turnoverBudgetMonthlyPct: (mandateResult.data as any)?.turnover_budget_monthly == null ? null : Number((mandateResult.data as any).turnover_budget_monthly),
    monthlyTurnoverUsedPct: args.portfolioNav > 0 ? monthlyTurnover / args.portfolioNav * 100 : null,
    proposedTurnoverPct: args.portfolioNav > 0 ? proposedTurnover / args.portfolioNav * 100 : null,
    taxSensitivity: ["low", "high"].includes(String((mandateResult.data as any)?.tax_sensitivity))
      ? (mandateResult.data as any).tax_sensitivity : "medium",
    hasExactTaxLots: exactLots,
    // A score gap becomes an executable economic premise only when its matched,
    // session-independent lower confidence bound is positive. The raw mean is
    // retained in the audit but is never used to pass this gate.
    expectedEdgePct: scoreEdgeEvidence.status === "validated" ? scoreEdgeEvidence.lowerConfidenceEdgePct : null,
    frictionPct,
    postSwapAllowed,
    correlation,
    correlationAllowed,
  });
  if (!evaluation.eligible) {
    readiness.ready = false;
    readiness.blockers.unshift(`candidate_not_eligible:${evaluation.reason}`);
  }
  evaluation.gates.p1_ready = readiness.ready;
  evaluation.gates.p1_blockers = readiness.blockers;
  evaluation.gates.persistence_prior_runs = persistencePriorRuns;
  evaluation.gates.persistence_required_prior_runs = persistenceRequiredRuns;
  evaluation.gates.post_swap_allowed = postSwapAllowed;
  evaluation.gates.post_swap_adjustments = (evaluation.gates.replacement_capacity as Array<{ symbol: string; adjustments?: string[] }> | undefined)
    ?.find(row => row.symbol === sourceSymbol)?.adjustments ?? [];
  evaluation.gates.candidate_correlation = correlation;
  evaluation.gates.candidate_correlation_allowed = correlationAllowed;
  evaluation.gates.monthly_turnover_used_pct = readiness.turnoverAfterPct == null || args.portfolioNav <= 0 ? null : monthlyTurnover / args.portfolioNav * 100;
  evaluation.gates.proposed_turnover_pct = args.portfolioNav > 0 ? proposedTurnover / args.portfolioNav * 100 : null;
  evaluation.gates.exact_tax_lot = {
    available: exactLots,
    treatment: "paper_cost_basis_reconciled_not_statutory_tax_calculation",
  };
  evaluation.gates.score_to_return_mapping = scoreEdgeEvidence;

  const idempotencyKey = `paper:${candidate.market}:${args.runId ?? "manual"}:${candidate.signalId}:rotation-shadow`;
  const event = {
    market: candidate.market,
    currency: candidate.currency,
    book_type: "paper",
    idempotency_key: idempotencyKey,
    status: evaluation.status,
    candidate_symbol: candidate.symbol,
    source_symbol: evaluation.source?.symbol ?? null,
    candidate_signal_id: candidate.signalId,
    source_position_id: evaluation.source?.id ?? null,
    candidate_score: candidate.score,
    source_score: evaluation.source?.score ?? null,
    score_edge: evaluation.scoreEdge,
    sell_notional: evaluation.sellNotional,
    buy_notional: evaluation.buyNotional,
    turnover_consumed: evaluation.sellNotional != null ? evaluation.sellNotional + evaluation.buyNotional : null,
    cost_model_json: { phase: "p0_shadow", slippage_bps_per_leg: 5, friction_pct: frictionPct, spread_impact_fees_status: "unavailable" },
    tax_model_json: { phase: "p0_shadow", sensitivity: (mandateResult.data as any)?.tax_sensitivity ?? "medium", exact_lots_available: exactLots, tax_drag_status: "unavailable" },
    gate_results_json: evaluation.gates,
    audit_json: {
      reason: evaluation.reason,
      eligible: evaluation.eligible,
      no_execution: true,
      run_id: args.runId,
      p1_ready: readiness.ready,
      p1_blockers: readiness.blockers,
    },
  };

  const { error } = await supabase.from("rotation_events").insert(event);
  if (error && String(error.code ?? "") !== "23505") {
    throw new Error(`rotation_events insert failed: ${error.message}`);
  }
  const source = evaluation.source;
  return { evaluation, readiness, scoreEdgeEvidence, evaluatedAt: now.toISOString(),
    plan: source ? { sourceId: source.id, sourceQty: source.qty, sourcePrice: source.currentPrice,
      sourceScore: source.score, candidateSignalId: candidate.signalId, buyNotional: evaluation.buyNotional } : null,
  } satisfies RotationShadowRecord;
}

// ── Phase 1 PAPER EXECUTION (ENABLED 2026-07-23) ─────────────────────────────
// Gated by: CAPITAL_ROTATION_PAPER_ENABLED env var + per-market
// rotation_config.rotation_paper_execute_enabled (paper book only) + the
// atomic execute_paper_rotation RPC (sell source via execute_paper_exit,
// buy candidate via execute_paper_fill — one transaction, buy-leg denial
// rolls back the sell). There is NO live rotation path.
export interface RotationExecInput {
  runId: string | null;
  rotationsThisRun: number;
  candidate: RotationCandidate & {
    qty: number; fillPrice: number; priceTarget: number | null; stopLoss: number | null; sector: string | null;
  };
  scoreThreshold: number;
  minHoldingDays: number;
  /** Read from the immediately preceding append-only shadow event in this run. */
  p1Readiness: RotationP1Readiness | null;
  p1EvaluatedAt: string | null;
  p1Plan?: RotationShadowRecord["plan"];
  entryPolicy?: {
    maxOpenNames: number; maxSectorNames: number; perTradeCap: number | null;
    dailyNotionalCap: number | null; dayStart: string | null;
    mandateId: string | null; mandateVersion: number; mandateSnapshot: unknown; horizonDays: number;
  };
}

export async function executeCapitalRotationPaper(supabase: any, args: RotationExecInput): Promise<{ executed: boolean; reason: string; sourceSymbol?: string }> {
  const c = args.candidate;
  try {
    // The DB toggle is necessary but not sufficient. P1 must also be explicitly
    // enabled at deployment time after its architecture gates are approved.
    if (process.env.CAPITAL_ROTATION_PAPER_ENABLED !== "true") {
      return { executed: false, reason: "deployment_disabled" };
    }
    if (!args.runId) return { executed: false, reason: "missing_claim_run_id" };

    const { data: cfgRow, error: cfgError } = await supabase
      .from("rotation_config")
      .select("rotation_paper_execute_enabled, rotation_allow_score_only_paper, rotation_margin_score, rotation_persistence_runs, rotation_cooldown_days, max_rotations_per_run, max_rotations_per_day")
      .eq("market", c.market).eq("book_type", "paper").maybeSingle();
    if (cfgError) return { executed: false, reason: `config_query_failed:${cfgError.message}` };

    // GATE 0: master execution flag (default OFF).
    if (!(cfgRow as any)?.rotation_paper_execute_enabled) return { executed: false, reason: "execute_disabled" };
    // No confidence-qualified benchmark-alpha edge is available in this path.
    // The schema defaults score-only execution to false; honor that owner gate
    // before reading positions or invoking the atomic money-moving RPC.
    if ((cfgRow as any)?.rotation_allow_score_only_paper !== true) {
      return { executed: false, reason: "score_only_execution_disabled" };
    }
    // A score margin is not an economic edge by itself. The immediately
    // preceding shadow must have produced a complete turnover/lot/mapping/risk
    // contract. This check sits before any book read or RPC call.
    if (!args.p1Readiness?.ready) {
      const blockers = args.p1Readiness?.blockers?.join(",") ?? "shadow_evidence_unavailable";
      return { executed: false, reason: `p1_evidence_not_ready:${blockers}` };
    }
    const evidenceAgeMs = args.p1EvaluatedAt ? Date.now() - Date.parse(args.p1EvaluatedAt) : Number.NaN;
    if (!Number.isFinite(evidenceAgeMs) || evidenceAgeMs < 0 || evidenceAgeMs > 60_000) {
      return { executed: false, reason: "p1_evidence_stale" };
    }
    const plan = args.p1Plan;
    if (!plan || plan.candidateSignalId !== c.signalId || !Number.isFinite(c.qty * c.fillPrice)
      || Math.abs(plan.buyNotional - c.qty * c.fillPrice) > 1e-6
      || Math.abs(c.targetNotional - plan.buyNotional) > 1e-6) return { executed: false, reason: "p1_plan_mismatch" };
    if (!args.entryPolicy) return { executed: false, reason: "entry_policy_missing" };

    const persistenceRuns = Math.max(1, Number((cfgRow as any)?.rotation_persistence_runs ?? 2));
    const cooldownDays = Math.max(0, Number((cfgRow as any)?.rotation_cooldown_days ?? 3));
    const maxPerRun = Math.max(1, Number((cfgRow as any)?.max_rotations_per_run ?? 1));
    const maxPerDay = Math.max(1, Number((cfgRow as any)?.max_rotations_per_day ?? 2));
    const margin = Number((cfgRow as any)?.rotation_margin_score ?? 12);

    // GATE: per-run cap.
    if (args.rotationsThisRun >= maxPerRun) return { executed: false, reason: "max_rotations_per_run" };

    // Re-run the deterministic eligibility eval against the current book.
    const { data: positions, error: positionsError } = await supabase
      .from("paper_positions")
      .select("id, symbol, market, qty, avg_cost, current_price, opened_at, updated_at, price_target, stop_loss, exit_reason")
      .eq("market", c.market)
      .eq("position_role", "alpha");
    if (positionsError) return { executed: false, reason: `positions_query_failed:${positionsError.message}` };
    const symbols = (positions ?? []).map((p: any) => String(p.symbol)).filter(Boolean);
    const scores = await latestScoresBySymbol(supabase, c.market, symbols);
    const holdings: RotationHolding[] = (positions ?? []).map((p: any) => ({
      id: String(p.id), symbol: String(p.symbol), market: c.market,
      qty: Number(p.qty ?? 0), avgCost: Number(p.avg_cost ?? 0),
      currentPrice: Number(p.current_price ?? 0), openedAt: p.opened_at ?? null,
      priceFresh: isPaperScoreFresh(p.updated_at, new Date(), c.market, 1),
      priceTarget: p.price_target == null ? null : Number(p.price_target),
      stopLoss: p.stop_loss == null ? null : Number(p.stop_loss),
      exitReason: p.exit_reason ?? null, score: scores.get(String(p.symbol))?.score ?? null,
    }));
    const evaluation = evaluateCapitalRotationShadow({
      candidate: c, holdings: holdings.filter(h => h.id === plan.sourceId),
      config: { shadowEnabled: true, marginScore: margin, minHoldingDays: args.minHoldingDays, exitScoreThreshold: args.scoreThreshold - 10, nearTargetPct: 0.03, nearStopPct: 0.03 },
    });
    if (!evaluation.eligible || !evaluation.source) return { executed: false, reason: `not_eligible:${evaluation.reason}` };
    const source = evaluation.source;
    if (source.qty !== plan.sourceQty || source.currentPrice !== plan.sourcePrice || source.score !== plan.sourceScore) {
      return { executed: false, reason: "p1_source_changed" };
    }

    // GATE: per-day cap.
    const dayStart = new Date(); dayStart.setUTCHours(0, 0, 0, 0);
    const { count: todayCount, error: todayError } = await supabase
      .from("rotation_events").select("id", { count: "exact", head: true })
      .eq("market", c.market).eq("status", "paper_executed").gte("created_at", dayStart.toISOString());
    if (todayError) return { executed: false, reason: `daily_cap_query_failed:${todayError.message}` };
    if ((todayCount ?? 0) >= maxPerDay) return { executed: false, reason: "max_rotations_per_day" };

    // GATE: cooldown — no execution touching this candidate or source recently.
    if (cooldownDays > 0) {
      const cdStart = new Date(Date.now() - cooldownDays * 86400000).toISOString();
      const { data: recent, error: recentError } = await supabase
        .from("rotation_events").select("candidate_symbol, source_symbol")
        .eq("market", c.market).eq("status", "paper_executed").gte("created_at", cdStart);
      if (recentError) return { executed: false, reason: `cooldown_query_failed:${recentError.message}` };
      const hit = (recent ?? []).some((r: any) => r.candidate_symbol === c.symbol || r.source_symbol === source.symbol || r.candidate_symbol === source.symbol);
      if (hit) return { executed: false, reason: "cooldown_active" };
    }

    // GATE: persistence — the candidate must have been a planned/eligible rotation
    // in >= (persistenceRuns-1) prior runs (anti-thrash on a one-day score blip).
    if (persistenceRuns > 1) {
      const pStart = new Date(Date.now() - 4 * 86400000).toISOString();
      const { data: priorRows, error: persistenceError } = await supabase
        .from("rotation_events").select("audit_json")
        .eq("market", c.market).eq("candidate_symbol", c.symbol).eq("status", "planned").gte("created_at", pStart);
      if (persistenceError) return { executed: false, reason: `persistence_query_failed:${persistenceError.message}` };
      const priorRuns = countDistinctPriorRotationRuns(priorRows ?? [], args.runId);
      if (priorRuns < persistenceRuns - 1) return { executed: false, reason: "awaiting_persistence" };
    }

    // Execute atomically.
    const idempotencyKey = `paper-exec:${c.market}:${args.runId ?? "manual"}:${c.signalId}:${source.id}`;
    const { data: rpc, error: rpcErr } = await supabase.rpc("execute_paper_rotation", {
      p_market: c.market, p_currency: c.currency, p_source_position_id: source.id,
      p_candidate_symbol: c.symbol, p_candidate_signal_id: c.signalId, p_candidate_qty: c.qty,
      p_candidate_fill_price: c.fillPrice, p_candidate_price_target: c.priceTarget, p_candidate_stop_loss: c.stopLoss,
      p_candidate_sector: c.sector, p_candidate_score: c.score, p_source_score: source.score,
      p_score_edge: evaluation.scoreEdge, p_idempotency_key: idempotencyKey,
      p_claim_run_id: args.runId,
      p_gate_json: { ...evaluation.gates, persistence_runs: persistenceRuns, cooldown_days: cooldownDays, p1_plan: plan, p1_readiness: args.p1Readiness, p1_evaluated_at: args.p1EvaluatedAt, entry_policy: args.entryPolicy },
    });
    if (rpcErr) return { executed: false, reason: `rpc_error:${rpcErr.message}` };
    if (!(rpc as any)?.ok) return { executed: false, reason: `rpc_denied:${(rpc as any)?.error ?? "unknown"}` };
    return { executed: true, reason: "rotated", sourceSymbol: source.symbol };
  } catch (e: any) {
    return { executed: false, reason: `exception:${String(e?.message ?? e)}` };
  }
}
