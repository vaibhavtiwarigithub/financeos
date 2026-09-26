// Capital-rotation P1 evidence helpers. These are deliberately pure: the
// database reader lives in capital-rotation.ts and cannot silently change the
// interpretation of the evidence contract.

export interface RotationScoreOutcome {
  sessionDate: string;
  observedAt: string;
  symbol: string;
  role: "candidate" | "holding";
  score: number;
  forwardReturn: number;
}

export interface RotationScoreEdgeEvidence {
  status: "insufficient" | "not_positive" | "validated";
  distinctSessions: number;
  independentSessions: number;
  pairCount: number;
  meanEdgePct: number | null;
  lowerConfidenceEdgePct: number | null;
  tStatistic: number | null;
  requiredIndependentSessions: number;
  horizonDays: number;
}

function finite(value: unknown): number | null {
  if (value == null || typeof value === "boolean" || (typeof value === "string" && value.trim() === "")) return null;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function mean(values: number[]): number | null {
  if (!values.length) return null;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function sampleStdDev(values: number[], average: number): number | null {
  if (values.length < 2) return null;
  const variance = values.reduce((sum, value) => sum + (value - average) ** 2, 0) / (values.length - 1);
  return Math.sqrt(variance);
}

/**
 * Estimate the forward-return advantage of a rotation score edge.
 *
 * Every session contributes one mean across its valid candidate/holding pairs,
 * so a broad day cannot masquerade as independent evidence. We then retain one
 * session per horizon-sized block; forward windows for adjacent sessions overlap
 * and must not be treated as independent trials. The returned lower bound is in
 * percentage points and is the only value suitable for a friction comparison.
 */
export function summarizeRotationScoreEdgeEvidence(
  rows: RotationScoreOutcome[],
  options: { minScoreEdge: number; horizonDays: number; requiredIndependentSessions?: number } = { minScoreEdge: 12, horizonDays: 10 },
): RotationScoreEdgeEvidence {
  const requiredIndependentSessions = options.requiredIndependentSessions ?? 20;
  const bySession = new Map<string, Map<string, RotationScoreOutcome>>();

  for (const row of rows) {
    const score = finite(row.score);
    const forwardReturn = finite(row.forwardReturn);
    const sessionDate = String(row.sessionDate ?? "").slice(0, 10);
    const symbol = String(row.symbol ?? "").trim().toUpperCase();
    if (!sessionDate || !symbol || score == null || forwardReturn == null) continue;
    const key = `${row.role}:${symbol}`;
    const session = bySession.get(sessionDate) ?? new Map<string, RotationScoreOutcome>();
    const prior = session.get(key);
    // A symbol can be scored more than once per date. Retain only its latest
    // point-in-time observation; counting both would duplicate the same name.
    if (!prior || Date.parse(row.observedAt) > Date.parse(prior.observedAt)) {
      session.set(key, { ...row, sessionDate, symbol, score, forwardReturn });
    }
    bySession.set(sessionDate, session);
  }

  const perSession: Array<{ date: string; edge: number; pairs: number }> = [];
  for (const [date, entries] of bySession) {
    const values = [...entries.values()];
    const candidates = values.filter(row => row.role === "candidate");
    const holdings = values.filter(row => row.role === "holding");
    const pairEdges: number[] = [];
    for (const candidate of candidates) for (const holding of holdings) {
      if (candidate.symbol === holding.symbol) continue;
      if (candidate.score - holding.score < options.minScoreEdge) continue;
      pairEdges.push(candidate.forwardReturn - holding.forwardReturn);
    }
    const sessionEdge = mean(pairEdges);
    if (sessionEdge != null) perSession.push({ date, edge: sessionEdge, pairs: pairEdges.length });
  }
  perSession.sort((a, b) => a.date.localeCompare(b.date));

  // One observation per horizon block gives a conservative, non-overlapping
  // effective sample without pretending calendar days are trading sessions.
  const independent = perSession.filter((_, index) => index % Math.max(1, options.horizonDays) === 0);
  const independentEdges = independent.map(row => row.edge);
  const average = mean(independentEdges);
  const stdDev = average == null ? null : sampleStdDev(independentEdges, average);
  const standardError = stdDev == null ? null : stdDev / Math.sqrt(independentEdges.length);
  const tStatistic = average != null && standardError != null && standardError > 0 ? average / standardError : null;
  // Normal 95% lower confidence bound is intentionally conservative at the
  // evidence floor (20 sessions); no estimate is emitted below that floor.
  const lower = average != null && standardError != null ? average - 1.96 * standardError : null;
  const enough = independent.length >= requiredIndependentSessions;
  const lowerPct = enough && lower != null ? lower * 100 : null;
  const status = !enough ? "insufficient" : lowerPct != null && lowerPct > 0 ? "validated" : "not_positive";

  return {
    status,
    distinctSessions: perSession.length,
    independentSessions: independent.length,
    pairCount: perSession.reduce((sum, row) => sum + row.pairs, 0),
    meanEdgePct: average == null ? null : average * 100,
    lowerConfidenceEdgePct: lowerPct,
    tStatistic,
    requiredIndependentSessions,
    horizonDays: options.horizonDays,
  };
}

export interface PaperLotSnapshot {
  symbol: string;
  openedAt: string | null;
  qty: number;
  avgCost: number;
}

export interface PaperBuyFill {
  id?: number;
  symbol: string;
  createdAt: string;
  qty: number;
  fillPrice: number;
  fillStatus: string | null;
}

export interface PaperTradeLot {
  paperEventId: number | null;
  qty: number;
  fillPrice: number;
  closedAt: string | null;
  fillStatus: string | null;
}

/**
 * Paper has no statutory tax calculation. "Exact lot" here means the source
 * position has exactly one traceable filled buy after its recorded opening time,
 * and that buy reconciles to the open position's quantity and cost basis. Any
 * add-to-position, merged basis, missing timestamp or mismatch fails closed.
 */
export function hasExactPaperTaxLot(position: PaperLotSnapshot | null, fills: PaperBuyFill[], lots: PaperTradeLot[] = []): boolean {
  if (!position || !position.openedAt || finite(position.qty) == null || finite(position.avgCost) == null) return false;
  const openedAt = Date.parse(position.openedAt);
  if (!Number.isFinite(openedAt) || position.qty <= 0 || position.avgCost <= 0) return false;
  const symbol = position.symbol.trim().toUpperCase();
  const matching = fills.filter(fill => {
    const filledAt = Date.parse(fill.createdAt);
    return fill.symbol.trim().toUpperCase() === symbol
      && fill.fillStatus === "filled"
      // The fill and position insert share a transaction; allow one minute for
      // timestamp precision but never search arbitrarily far into history.
      && Number.isFinite(filledAt) && filledAt >= openedAt - 60_000;
  });
  if (matching.length !== 1) return false;
  const fill = matching[0];
  const costMatches = Math.abs(fill.fillPrice - position.avgCost) <= Math.max(1e-6, Math.abs(position.avgCost) * 1e-6);
  if (!costMatches || finite(fill.qty) == null || fill.qty <= 0) return false;
  const sameQuantity = Math.abs(fill.qty - position.qty) <= 1e-8;
  if (sameQuantity) return true;
  // A partial exit splits one original buy into closed and open paper_trades
  // rows. Prove the split against the original fill event before accepting the
  // remaining cost basis; a timestamp/symbol match alone is insufficient.
  if (fill.id == null || fill.qty < position.qty || lots.length === 0) return false;
  if (lots.some(lot => lot.paperEventId !== fill.id || lot.fillStatus !== "filled"
    || finite(lot.qty) == null || lot.qty <= 0
    || Math.abs(lot.fillPrice - fill.fillPrice) > Math.max(1e-6, Math.abs(fill.fillPrice) * 1e-6))) return false;
  const open = lots.filter(lot => lot.closedAt == null);
  const closed = lots.filter(lot => lot.closedAt != null);
  return open.length === 1 && closed.length > 0
    && Math.abs(open[0].qty - position.qty) <= 1e-8
    && Math.abs(lots.reduce((sum, lot) => sum + lot.qty, 0) - fill.qty) <= 1e-8;
}
