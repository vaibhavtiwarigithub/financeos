export interface MissedEntrySnapshot {
  decision_at: string; market: "us" | "india"; symbol: string;
  reference_price: number; hypothetical_fill_price: number;
  hypothetical_qty: number | null; hypothetical_notional: number | null;
  stop_loss: number; price_target: number; horizon_sessions: number;
}
export interface MissedCloseRow {
  symbol: string; market: string; session_date: string; available_at: string;
  price_basis?: string | null; close: number | string; id?: number | null;
}
export interface MissedMarkPoint { date: string; missedReturnPct: number; benchmarkReturnPct: number | null; }
const finite = (n: unknown) => n != null && typeof n !== "boolean" && String(n).trim() !== "" && Number.isFinite(Number(n)) ? Number(n) : null;

function localDecisionDate(at: string, market: "us" | "india"): string {
  const zone = market === "us" ? "America/New_York" : "Asia/Kolkata";
  return new Intl.DateTimeFormat("en-CA", { timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(at));
}

/** Daily close-only forward path, censored at a later real paper buy. */
export function buildMissedOpportunityMarks(args: {
  snapshot: MissedEntrySnapshot; symbolCloses: MissedCloseRow[];
  benchmarkCloses: MissedCloseRow[]; benchmarkSymbol: string; subsequentBuyAt?: string | null;
}) {
  const { snapshot } = args;
  const afterDate = localDecisionDate(snapshot.decision_at, snapshot.market);
  const buyDate = args.subsequentBuyAt ? localDecisionDate(args.subsequentBuyAt, snapshot.market) : null;
  const cleanFuture = (rows: MissedCloseRow[]) => rows.filter(row =>
    row.session_date > afterDate && row.available_at > snapshot.decision_at
      && (row.price_basis == null || row.price_basis === "raw_close")
      && finite(row.close) != null && Number(finite(row.close)) > 0
      && (!buyDate || row.session_date < buyDate))
    .sort((a, b) => a.session_date.localeCompare(b.session_date));
  const latestBySession = (rows: MissedCloseRow[]) => {
    const latest = new Map<string, MissedCloseRow>();
    for (const row of rows) {
      const previous = latest.get(row.session_date);
      if (!previous || row.available_at > previous.available_at
        || (row.available_at === previous.available_at && Number(row.id ?? 0) > Number(previous.id ?? 0))) latest.set(row.session_date, row);
    }
    return [...latest.values()].sort((a, b) => a.session_date.localeCompare(b.session_date));
  };
  const symbolRows = latestBySession(cleanFuture(args.symbolCloses).filter(r => r.symbol.toUpperCase() === snapshot.symbol.toUpperCase() && r.market === snapshot.market));
  const benchmarkAll = latestBySession(args.benchmarkCloses.filter(row => row.symbol === args.benchmarkSymbol && row.market === snapshot.market && finite(row.close) != null && Number(finite(row.close)) > 0));
  // Establish the comparison benchmark only from the prior completed session;
  // the decision-session close may occur after the intraday entry decision.
  const benchmarkBase = benchmarkAll.filter(row => row.session_date < afterDate && row.available_at <= snapshot.decision_at).at(-1);
  const benchmarkRows = latestBySession(cleanFuture(benchmarkAll));
  const benchmarkByDate = new Map(benchmarkRows.map(row => [row.session_date, Number(finite(row.close))]));
  let peak = 0, maxDrawdown = 0, riskManagedReturnPct: number | null = null;
  let riskManagedExitSession: string | null = null, riskManagedExitReason: "stop_close" | "target_close" | "horizon_close" | null = null;
  let closeStopSession: string | null = null, closeTargetSession: string | null = null;
  const points: MissedMarkPoint[] = [{ date: afterDate, missedReturnPct: 0, benchmarkReturnPct: benchmarkBase ? 0 : null }];
  let matched = 0;
  for (const row of symbolRows.slice(0, snapshot.horizon_sessions)) {
    const close = finite(row.close);
    if (close == null || snapshot.hypothetical_fill_price <= 0) continue;
    const missedReturnPct = (close / snapshot.hypothetical_fill_price - 1) * 100;
    const priorPeak = peak;
    peak = Math.max(peak, missedReturnPct);
    const peakFactor = 1 + Math.max(0, priorPeak) / 100;
    maxDrawdown = Math.min(maxDrawdown, ((1 + missedReturnPct / 100) / peakFactor - 1) * 100);
    if (riskManagedReturnPct == null && ((snapshot.stop_loss > 0 && close <= snapshot.stop_loss)
      || (snapshot.price_target > 0 && close >= snapshot.price_target))) {
      riskManagedReturnPct = missedReturnPct;
      riskManagedExitSession = row.session_date;
      riskManagedExitReason = snapshot.stop_loss > 0 && close <= snapshot.stop_loss ? "stop_close" : "target_close";
      if (riskManagedExitReason === "stop_close") closeStopSession = row.session_date;
      else closeTargetSession = row.session_date;
    }
    const benchmarkClose = benchmarkByDate.get(row.session_date);
    let benchmarkReturnPct: number | null = null;
    if (benchmarkBase && benchmarkClose != null) { benchmarkReturnPct = (benchmarkClose / Number(benchmarkBase.close) - 1) * 100; matched++; }
    points.push({ date: row.session_date, missedReturnPct, benchmarkReturnPct });
  }
  const last = points.at(-1);
  const matured = symbolRows.length >= snapshot.horizon_sessions && !args.subsequentBuyAt;
  const returnPct = last?.missedReturnPct ?? null;
  if (riskManagedReturnPct == null && matured) {
    riskManagedReturnPct = returnPct;
    riskManagedExitSession = last?.date ?? null;
    riskManagedExitReason = "horizon_close";
  }
  return {
    points, benchmarkSymbol: args.benchmarkSymbol, matchedSessions: matched,
    observedSessions: Math.min(symbolRows.length, snapshot.horizon_sessions),
    horizonSessions: snapshot.horizon_sessions, matured,
    status: args.subsequentBuyAt ? "censored_by_later_fill" : matured ? "matured_close_proxy" : "mark_to_market_close_proxy",
    missedReturnPct: returnPct,
    missedPnl: snapshot.hypothetical_notional != null && returnPct != null ? snapshot.hypothetical_notional * returnPct / 100 : null,
    riskManagedReturnPct,
    riskManagedPnl: snapshot.hypothetical_notional != null && riskManagedReturnPct != null ? snapshot.hypothetical_notional * riskManagedReturnPct / 100 : null,
    benchmarkReturnPct: last?.benchmarkReturnPct ?? null,
    excessReturnPct: returnPct != null && last?.benchmarkReturnPct != null ? returnPct - last.benchmarkReturnPct : null,
    maxDrawdownPct: maxDrawdown,
    closeStopSession, closeTargetSession,
    riskManagedExitSession, riskManagedExitReason,
    stopTargetMethod: "close_only_diagnostic_no_intraday_touch_or_fill_claim",
    priceBasis: "raw_close",
  };
}
