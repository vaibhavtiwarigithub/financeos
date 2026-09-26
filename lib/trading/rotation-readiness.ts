export interface RotationReturnRow {
  symbol: string;
  session_date: string;
  simple_return: number | string;
  available_at?: string | null;
}

export interface RotationCorrelationResult {
  status: "ok" | "insufficient_data";
  maxAbsCorrelation: number | null;
  maxCorrelationSymbol: string | null;
  pairCount: number;
  expectedPairCount: number;
  minOverlap: number;
}

export interface RotationP1ReadinessInput {
  persistencePriorRuns: number;
  persistenceRequiredRuns: number;
  turnoverBudgetMonthlyPct: number | null;
  monthlyTurnoverUsedPct: number | null;
  proposedTurnoverPct: number | null;
  taxSensitivity: "low" | "medium" | "high";
  hasExactTaxLots: boolean;
  expectedEdgePct: number | null;
  frictionPct: number | null;
  postSwapAllowed: boolean | null;
  correlation: RotationCorrelationResult;
  correlationAllowed?: boolean | null;
}

export interface RotationP1Readiness {
  ready: boolean;
  blockers: string[];
  netExpectedEdgePct: number | null;
  turnoverAfterPct: number | null;
}

function finite(value: unknown): number | null {
  if (value == null || typeof value === "boolean" || (typeof value === "string" && value.trim() === "")) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function pearson(a: number[], b: number[]): number | null {
  if (a.length !== b.length || a.length < 2) return null;
  const meanA = a.reduce((sum, value) => sum + value, 0) / a.length;
  const meanB = b.reduce((sum, value) => sum + value, 0) / b.length;
  let covariance = 0;
  let varianceA = 0;
  let varianceB = 0;
  for (let i = 0; i < a.length; i++) {
    const da = a[i] - meanA;
    const db = b[i] - meanB;
    covariance += da * db;
    varianceA += da * da;
    varianceB += db * db;
  }
  if (!(varianceA > 0) || !(varianceB > 0)) return null;
  const result = covariance / Math.sqrt(varianceA * varianceB);
  return Number.isFinite(result) ? Math.max(-1, Math.min(1, result)) : null;
}

export function measureCandidatePostSwapCorrelation(
  rows: RotationReturnRow[],
  candidateSymbol: string,
  holdingSymbols: string[],
  minOverlap = 60,
): RotationCorrelationResult {
  const newest = new Map<string, RotationReturnRow>();
  for (const row of rows) {
    const symbol = String(row.symbol ?? "").trim().toUpperCase();
    const date = String(row.session_date ?? "").slice(0, 10);
    const value = finite(row.simple_return);
    if (!symbol || !date || value == null) continue;
    const key = `${symbol}:${date}`;
    const incumbent = newest.get(key);
    if (!incumbent || String(row.available_at ?? "") > String(incumbent.available_at ?? "")) newest.set(key, row);
  }

  const series = new Map<string, Map<string, number>>();
  for (const row of newest.values()) {
    const symbol = row.symbol.trim().toUpperCase();
    if (!series.has(symbol)) series.set(symbol, new Map());
    series.get(symbol)!.set(row.session_date.slice(0, 10), Number(row.simple_return));
  }

  const candidate = candidateSymbol.trim().toUpperCase();
  const expectedSymbols = [...new Set(holdingSymbols.map(symbol => symbol.trim().toUpperCase()).filter(symbol => symbol && symbol !== candidate))];
  const expectedPairCount = expectedSymbols.length;
  const candidateSeries = series.get(candidate);
  if (!candidateSeries) return { status: "insufficient_data", maxAbsCorrelation: null, maxCorrelationSymbol: null, pairCount: 0, expectedPairCount, minOverlap };

  let maxAbsCorrelation: number | null = null;
  let maxCorrelationSymbol: string | null = null;
  let pairCount = 0;
  for (const rawSymbol of expectedSymbols) {
    const holdingSeries = series.get(rawSymbol);
    if (!holdingSeries) continue;
    const a: number[] = [];
    const b: number[] = [];
    for (const [date, candidateReturn] of candidateSeries) {
      const holdingReturn = holdingSeries.get(date);
      if (holdingReturn == null) continue;
      a.push(candidateReturn);
      b.push(holdingReturn);
    }
    if (a.length < minOverlap) continue;
    const correlation = pearson(a, b);
    if (correlation == null) continue;
    pairCount += 1;
    const absolute = Math.abs(correlation);
    if (maxAbsCorrelation == null || absolute > maxAbsCorrelation) {
      maxAbsCorrelation = absolute;
      maxCorrelationSymbol = rawSymbol;
    }
  }
  return pairCount < expectedPairCount || expectedPairCount === 0
    ? { status: "insufficient_data", maxAbsCorrelation: null, maxCorrelationSymbol: null, pairCount, expectedPairCount, minOverlap }
    : { status: "ok", maxAbsCorrelation, maxCorrelationSymbol, pairCount, expectedPairCount, minOverlap };
}

export function estimateRotationFrictionPct(sellNotional: number, buyNotional: number): number | null {
  if (![sellNotional, buyNotional].every(n => Number.isFinite(n) && n > 0)) return null;
  // Paper fills currently apply 5 bps adverse slippage per leg. Spread, impact,
  // fees, and tax are deliberately not guessed here and remain separate blockers.
  // Expected edge is a return on BUY capital, not sell+buy turnover. An equal
  // sized replacement incurs 10 bps across two 5-bps legs, not 5 bps.
  return ((sellNotional * 0.0005) + (buyNotional * 0.0005)) / buyNotional * 100;
}

/** Executed rotations only. Ordinary entries/exits and shadow plans aren't churn. */
export function rotationTurnoverNotional(rows: Array<{ status: string; sell_notional: unknown; buy_notional: unknown }>): number {
  return rows.reduce((sum, row) => {
    if (row.status !== "paper_executed") return sum;
    const sell = finite(row.sell_notional), buy = finite(row.buy_notional);
    if (sell == null || buy == null || sell <= 0 || buy <= 0) throw new Error("rotation turnover contains an invalid executed notional");
    const total = sum + sell + buy;
    if (!Number.isFinite(total)) throw new Error("rotation turnover overflow");
    return total;
  }, 0);
}

export function assessRotationP1Readiness(input: RotationP1ReadinessInput): RotationP1Readiness {
  const blockers: string[] = [];
  // NaN makes every comparison false and must never become ready=true.
  const numbers = [input.persistencePriorRuns, input.persistenceRequiredRuns,
    input.turnoverBudgetMonthlyPct, input.monthlyTurnoverUsedPct, input.proposedTurnoverPct,
    input.expectedEdgePct, input.frictionPct];
  if (numbers.some(n => n != null && !Number.isFinite(n))) blockers.push("invalid_numeric_evidence");
  if ([input.persistencePriorRuns, input.persistenceRequiredRuns].some(n => !Number.isInteger(n) || n < 0)
    || [input.monthlyTurnoverUsedPct, input.proposedTurnoverPct, input.frictionPct].some(n => n != null && n < 0)) blockers.push("invalid_numeric_evidence");
  if (input.persistencePriorRuns < input.persistenceRequiredRuns) blockers.push("persistence_not_met");
  if (input.turnoverBudgetMonthlyPct == null || input.turnoverBudgetMonthlyPct <= 0) blockers.push("turnover_budget_not_configured");
  if (input.monthlyTurnoverUsedPct == null || input.proposedTurnoverPct == null) blockers.push("turnover_usage_unavailable");
  const turnoverAfterPct = input.monthlyTurnoverUsedPct != null && input.proposedTurnoverPct != null
    ? input.monthlyTurnoverUsedPct + input.proposedTurnoverPct
    : null;
  if (turnoverAfterPct != null && input.turnoverBudgetMonthlyPct != null && turnoverAfterPct > input.turnoverBudgetMonthlyPct) blockers.push("turnover_budget_exceeded");
  if (input.taxSensitivity !== "low" && !input.hasExactTaxLots) blockers.push("exact_tax_lots_unavailable");
  if (input.expectedEdgePct == null) blockers.push("score_to_return_mapping_unvalidated");
  if (input.frictionPct == null) blockers.push("friction_unavailable");
  if (input.postSwapAllowed !== true) blockers.push(input.postSwapAllowed == null ? "post_swap_gate_unavailable" : "post_swap_gate_failed");
  if (input.correlation.status !== "ok") blockers.push("candidate_correlation_unavailable");
  else if (!Number.isFinite(input.correlation.maxAbsCorrelation) || input.correlation.maxAbsCorrelation == null
    || input.correlation.maxAbsCorrelation < 0 || input.correlation.maxAbsCorrelation > 1
    || input.correlation.pairCount !== input.correlation.expectedPairCount || input.correlation.pairCount < 1) {
    blockers.push("candidate_correlation_unavailable");
  } else if (input.correlationAllowed === false) {
    blockers.push("candidate_correlation_failed");
  } else if (input.correlationAllowed == null) {
    blockers.push("candidate_correlation_unavailable");
  }

  const netExpectedEdgePct = input.expectedEdgePct != null && input.frictionPct != null
    ? input.expectedEdgePct - input.frictionPct
    : null;
  if (netExpectedEdgePct != null && netExpectedEdgePct <= 0) blockers.push("net_edge_not_positive");
  return { ready: blockers.length === 0, blockers: [...new Set(blockers)], netExpectedEdgePct, turnoverAfterPct };
}
