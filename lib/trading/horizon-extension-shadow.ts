// Conditional horizon extension — IMPURE SHELL (shadow recorder).
//
// Resolves the inputs decideExtension() needs from production state and records
// what the policy WOULD have done. It changes nothing: it does not close, hold,
// size, or touch paper_positions. Its only side effect is an append-only row in
// horizon_extension_shadow.
//
// Deliberate design choices:
//  - Age, score freshness and the open timestamp are computed with the SAME
//    helpers PositionMonitor uses (tradingWeekdaysBetween, isPaperScoreFresh,
//    paperPositionOpenedAt). A shadow that measured age differently from the live
//    time stop would be answering a different question than the one being asked.
//  - Hedge positions are skipped. They have their own exit path and are not swing
//    entries whose horizon is under review.
//  - Every input that cannot be resolved is recorded as null and the pure core
//    fails closed on it, so the first thing this shadow reveals is WHICH evidence
//    is unavailable — that is a finding, not a gap to paper over.
import { decideExtension, type ExtensionInputs, type ExtensionVerdict } from "@/lib/trading/horizon-extension";
import { loadTradingMandate, tradingWeekdaysBetween } from "@/lib/trading-mandate";
import { isPaperScoreFresh, paperPositionOpenedAt } from "@/lib/trading/paper-exit-policy";
import { getBenchmarkSeries } from "@/lib/data/benchmark-series";

export interface ShadowRow extends ExtensionVerdict {
  market: "us" | "india";
  symbol: string;
  position_id: string;
  age_days: number;
  horizon_days: number;
  ceiling_days: number;
  score: number | null;
  score_fresh: boolean;
  prior_score: number | null;
  entry_threshold: number;
  unrealized_pct: number | null;
  benchmark_rel_pct: number | null;
  price_above_ema20: boolean | null;
  breakdown_veto: boolean | null;
  earnings_veto: boolean | null;
  data_quality_ok: boolean | null;
}

/** breakdown_veto was stored as { vetoed, reasons } before 2026-08-11. Unwrap both shapes. */
function vetoOf(v: unknown): boolean | null {
  if (v == null) return null;
  if (typeof v === "boolean") return v;
  if (typeof v === "object") return Boolean((v as any).vetoed);
  return null;
}

/** Benchmark return over the same window the position has been held, in points. */
function benchmarkReturnPct(series: { date: string; close: number }[], openedAt: string): number | null {
  if (series.length < 2) return null;
  const openDay = openedAt.slice(0, 10);
  // First bar on/after the open — the benchmark's own entry point for this hold.
  const start = series.find((b) => b.date >= openDay);
  const end = series[series.length - 1];
  if (!start || !end || !(start.close > 0)) return null;
  return ((end.close - start.close) / start.close) * 100;
}

export async function runHorizonExtensionShadow(
  supabase: any,
  opts: { market?: "us" | "india"; now?: Date; persist?: boolean } = {},
): Promise<{ runId: string; evaluated: number; rows: ShadowRow[]; persisted: boolean }> {
  const now = opts.now ?? new Date();
  const runId = `hxs-${now.toISOString().slice(0, 19).replace(/[:T]/g, "")}`;

  const { data: positions } = await supabase
    .from("paper_positions")
    .select("id, symbol, market, qty, avg_cost, current_price, opened_at, created_at, resolved_horizon_days, position_role");

  const open = (positions ?? []).filter((p: any) => {
    if (p.position_role === "hedge") return false;
    if (opts.market && (p.market ?? "us") !== opts.market) return false;
    return Number(p.qty) > 0;
  });
  if (!open.length) return { runId, evaluated: 0, rows: [], persisted: false };

  const markets: Array<"us" | "india"> =
    [...new Set(open.map((p: any) => ((p.market ?? "us") as "us" | "india")))] as Array<"us" | "india">;
  const mandates = new Map<string, any>();
  const benches = new Map<string, { date: string; close: number }[]>();
  for (const m of markets) {
    mandates.set(m, await loadTradingMandate(supabase, m).catch(() => null));
    benches.set(m, await getBenchmarkSeries(m, supabase).catch(() => []));
  }

  const symbols: string[] = [...new Set(open.map((p: any) => String(p.symbol)))] as string[];

  // Scores: newest first, so the first hit per symbol is the current one and a
  // later hit supplies the prior-checkpoint comparison.
  const { data: scoreRows } = await supabase
    .from("signal_score_history")
    .select("symbol, market, analyst_score, created_at, technical_breakdown")
    .in("symbol", symbols)
    .order("created_at", { ascending: false })
    .limit(1000);

  const latest = new Map<string, any>();
  const prior = new Map<string, any>();
  for (const r of scoreRows ?? []) {
    const key = `${r.symbol}:${r.market ?? "us"}`;
    if (!latest.has(key)) { latest.set(key, r); continue; }
    if (prior.has(key)) continue;
    // Prior = the most recent score from a DIFFERENT day, so intraday re-runs do
    // not compare a score against itself and mask real decay.
    if (String(r.created_at).slice(0, 10) !== String(latest.get(key).created_at).slice(0, 10)) prior.set(key, r);
  }

  // Earnings inside the extension window.
  const { data: earnRows } = await supabase
    .from("earnings_risk_observations")
    .select("symbol, market, sessions_until_report, earnings_status, observed_at")
    .in("symbol", symbols)
    .order("observed_at", { ascending: false })
    .limit(1000);
  const earn = new Map<string, any>();
  for (const e of earnRows ?? []) {
    const key = `${e.symbol}:${e.market ?? "us"}`;
    if (!earn.has(key)) earn.set(key, e);
  }

  // Data quality from the decision record that produced the current score.
  const { data: obsRows } = await supabase
    .from("decision_observations")
    .select("symbol, market, ts, availability_mask, evidence_confidence")
    .in("symbol", symbols)
    .order("ts", { ascending: false })
    .limit(1000);
  const obs = new Map<string, any>();
  for (const o of obsRows ?? []) {
    const key = `${o.symbol}:${o.market ?? "us"}`;
    if (!obs.has(key)) obs.set(key, o);
  }

  const rows: ShadowRow[] = [];

  for (const p of open) {
    const market = (p.market ?? "us") as "us" | "india";
    const key = `${p.symbol}:${market}`;
    const mandate = mandates.get(market);
    const openedAt = paperPositionOpenedAt(p);
    if (!openedAt || !mandate) continue;

    const ageDays = tradingWeekdaysBetween(new Date(openedAt), now);
    const horizonDays = Number.isFinite(Number(p.resolved_horizon_days))
      ? Number(p.resolved_horizon_days)
      : mandate.target_hold_days;
    const ceilingDays = mandate.max_hold_days;
    const entryThreshold = mandate.score_threshold ?? 60;

    const cur = latest.get(key);
    const prv = prior.get(key);
    const tb = cur?.technical_breakdown ?? null;
    const scoreFresh = isPaperScoreFresh(cur?.created_at, now, market, mandate.max_signal_age_sessions ?? 2);

    const avg = Number(p.avg_cost);
    const px = Number(p.current_price);
    const unrealizedPct = avg > 0 && Number.isFinite(px) ? ((px - avg) / avg) * 100 : null;

    const benchPct = benchmarkReturnPct(benches.get(market) ?? [], openedAt);
    const benchmarkRelPct = unrealizedPct != null && benchPct != null ? unrealizedPct - benchPct : null;

    const ema20 = tb?.ema20 != null ? Number(tb.ema20) : null;
    const tbPrice = tb?.price != null ? Number(tb.price) : (Number.isFinite(px) ? px : null);
    const priceAboveEma20 = ema20 != null && tbPrice != null ? tbPrice > ema20 : null;

    const e = earn.get(key);
    // Veto when a report lands inside the remaining extension window. Unknown
    // status is NOT treated as "no earnings" — that would be an assumption the
    // fail-closed core is designed to refuse.
    const sessionsLeft = Math.max(0, ceilingDays - ageDays);
    const earningsVeto = e == null
      ? null
      : e.sessions_until_report == null
        ? null
        : Number(e.sessions_until_report) <= sessionsLeft;

    const o = obs.get(key);
    const mask = o?.availability_mask as Record<string, boolean> | undefined;
    const dataQualityOk = mask == null
      ? null
      : Boolean(mask.technical) && Boolean(mask.fundamental);

    const inputs: ExtensionInputs = {
      market, ageDays, horizonDays, ceilingDays,
      score: cur?.analyst_score != null ? Number(cur.analyst_score) : null,
      scoreFresh,
      priorScore: prv?.analyst_score != null ? Number(prv.analyst_score) : null,
      entryThreshold,
      unrealizedPct,
      benchmarkRelPct,
      priceAboveEma20,
      breakdownVeto: vetoOf(tb?.breakdown_veto),
      earningsVeto,
      dataQualityOk,
    };

    const verdict = decideExtension(inputs);

    rows.push({
      ...verdict,
      market, symbol: p.symbol, position_id: String(p.id),
      age_days: ageDays, horizon_days: horizonDays, ceiling_days: ceilingDays,
      score: inputs.score, score_fresh: scoreFresh, prior_score: inputs.priorScore,
      entry_threshold: entryThreshold,
      unrealized_pct: unrealizedPct, benchmark_rel_pct: benchmarkRelPct,
      price_above_ema20: priceAboveEma20, breakdown_veto: inputs.breakdownVeto,
      earnings_veto: earningsVeto, data_quality_ok: dataQualityOk,
    });
  }

  // Persist unless the caller asked for a dry run. Fail-open: the migration may
  // not be applied yet, and a shadow that cannot write must never break the caller.
  const shouldPersist = opts.persist !== false;
  let persisted = false;
  if (rows.length && shouldPersist) {
    try {
      const { error } = await supabase.from("horizon_extension_shadow").insert(
        rows.map((r) => ({
          run_id: runId, evaluated_at: now.toISOString(),
          market: r.market, symbol: r.symbol, position_id: r.position_id,
          age_days: r.age_days, horizon_days: r.horizon_days, ceiling_days: r.ceiling_days,
          would_extend: r.extend, reason: r.reason, failed: r.failed,
          effective_exit_day: r.effectiveExitDay,
          score: r.score, score_fresh: r.score_fresh, prior_score: r.prior_score,
          entry_threshold: r.entry_threshold,
          unrealized_pct: r.unrealized_pct, benchmark_rel_pct: r.benchmark_rel_pct,
          price_above_ema20: r.price_above_ema20, breakdown_veto: r.breakdown_veto,
          earnings_veto: r.earnings_veto, data_quality_ok: r.data_quality_ok,
        })),
      );
      persisted = !error;
    } catch { /* shadow persistence is best-effort */ }
  }

  return { runId, evaluated: rows.length, rows, persisted };
}
