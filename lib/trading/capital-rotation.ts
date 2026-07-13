export interface RotationCandidate {
  signalId: string;
  symbol: string;
  market: "us" | "india";
  currency: "USD" | "INR";
  score: number;
  targetNotional: number;
  cash: number;
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
  if (h.score == null || !Number.isFinite(h.score)) return "missing_fresh_score";
  if (h.score < cfg.exitScoreThreshold) return "below_exit_threshold";
  const held = daysHeld(h.openedAt, now);
  if (held == null || held < cfg.minHoldingDays) return "min_holding_days";
  const price = finitePositive(h.currentPrice) ?? finitePositive(h.avgCost);
  if (!price) return "missing_price";
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
      const reject = sourceRejectReason(h, cfg, now);
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
  const source = sellable[0];
  const scoreEdge = candidate.score - (source.score ?? 0);
  const sellNotional = holdingNotional(source);
  gates.score_edge = scoreEdge;
  gates.rotation_margin_score = cfg.marginScore;
  gates.sell_notional_covers_buy = sellNotional + candidate.cash >= candidate.targetNotional;

  if (scoreEdge < cfg.marginScore) {
    return { eligible: false, status: "rejected", reason: "score_edge_below_margin", source, scoreEdge, sellNotional, buyNotional: candidate.targetNotional, gates };
  }
  if (sellNotional + candidate.cash < candidate.targetNotional) {
    return { eligible: false, status: "rejected", reason: "source_does_not_fund_candidate", source, scoreEdge, sellNotional, buyNotional: candidate.targetNotional, gates };
  }

  return {
    eligible: true,
    status: "planned",
    reason: "shadow_rotation_candidate",
    source,
    scoreEdge,
    sellNotional,
    buyNotional: candidate.targetNotional,
    gates,
  };
}

async function latestScoresBySymbol(supabase: any, market: "us" | "india", symbols: string[]): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  if (symbols.length === 0) return out;
  const since = new Date(Date.now() - 7 * 86400000).toISOString();
  const { data } = await supabase
    .from("agent_signals")
    .select("symbol, analyst_score, created_at")
    .eq("market", market)
    .in("symbol", symbols)
    .gte("created_at", since)
    .order("created_at", { ascending: false })
    .limit(200);
  for (const row of (data ?? []) as any[]) {
    const sym = String(row.symbol ?? "");
    if (!sym || out.has(sym)) continue;
    const score = Number(row.analyst_score);
    if (Number.isFinite(score)) out.set(sym, score);
  }
  return out;
}

export async function recordCapitalRotationShadow(supabase: any, args: {
  runId: string | null;
  candidate: RotationCandidate;
  scoreThreshold: number;
  minHoldingDays: number;
}) {
  const candidate = args.candidate;
  const { data: cfgRow } = await supabase
    .from("rotation_config")
    .select("rotation_shadow_enabled, rotation_margin_score")
    .eq("market", candidate.market)
    .eq("book_type", "paper")
    .maybeSingle();

  const { data: positions } = await supabase
    .from("paper_positions")
    .select("id, symbol, market, qty, avg_cost, current_price, opened_at, price_target, stop_loss, exit_reason")
    .eq("market", candidate.market);

  const symbols = (positions ?? []).map((p: any) => String(p.symbol)).filter(Boolean);
  const scores = await latestScoresBySymbol(supabase, candidate.market, symbols);
  const holdings: RotationHolding[] = (positions ?? []).map((p: any) => ({
    id: String(p.id),
    symbol: String(p.symbol),
    market: candidate.market,
    qty: Number(p.qty ?? 0),
    avgCost: Number(p.avg_cost ?? 0),
    currentPrice: Number(p.current_price ?? p.avg_cost ?? 0),
    openedAt: p.opened_at ?? null,
    priceTarget: p.price_target == null ? null : Number(p.price_target),
    stopLoss: p.stop_loss == null ? null : Number(p.stop_loss),
    exitReason: p.exit_reason ?? null,
    score: scores.get(String(p.symbol)) ?? null,
  }));

  const evaluation = evaluateCapitalRotationShadow({
    candidate,
    holdings,
    config: {
      shadowEnabled: (cfgRow as any)?.rotation_shadow_enabled !== false,
      marginScore: Number((cfgRow as any)?.rotation_margin_score ?? 12),
      minHoldingDays: args.minHoldingDays,
      exitScoreThreshold: args.scoreThreshold - 10,
      nearTargetPct: 0.03,
      nearStopPct: 0.03,
    },
  });

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
    cost_model_json: { phase: "p0_shadow", costs_applied: false },
    tax_model_json: { phase: "p0_shadow", tax_drag_applied: false },
    gate_results_json: evaluation.gates,
    audit_json: {
      reason: evaluation.reason,
      eligible: evaluation.eligible,
      no_execution: true,
      run_id: args.runId,
    },
  };

  const { error } = await supabase.from("rotation_events").insert(event);
  if (error && String(error.code ?? "") !== "23505") {
    throw new Error(`rotation_events insert failed: ${error.message}`);
  }
  return evaluation;
}
