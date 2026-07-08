// G3: live portfolio-construction gate. Ports the paper path's cross-position risk
// limits (gross / name / sector / vol / correlation) onto the LIVE Execution Gateway.
//
// Builds the live book from the freshest account snapshot (NAV + positions) plus the
// candidate order, runs the deterministic constructPortfolio(), and reports whether the
// candidate would be shrunk or denied — i.e. whether placing it as-approved would breach
// a portfolio limit. BUY only; SELL reduces exposure and is exempt.
//
// Data reality: the snapshot has NAV + positions (symbol/qty/avg_cost) but NO sector, so
// name + gross caps are exact while sector/vol are best-effort (unknown-sector bucket).
// If no FRESH NAV is available the gate is SKIPPED (advisory), not fail-closed — the
// per-order + daily notional caps are the primary live-money bound; a stale-snapshot
// block would be too aggressive given the snapshot's refresh cadence.

import { constructPortfolio, DEFAULT_LIMITS, type BookPosition, type CandidateOrder, type PortfolioLimits } from "@/lib/portfolio/constructor";

const SNAPSHOT_MAX_AGE_MS = 30 * 60 * 1000;

export interface LivePortfolioGateResult {
  ok: boolean;            // true = no breach (or gate skipped); false = would breach a limit
  skipped?: boolean;      // true = could not evaluate (no fresh NAV) — advisory only
  reason?: string;        // human-readable breach/skip reason
  adjustments?: string[]; // the constructor's per-rule shrink explanations
}

// market note: only "us" has a live NAV snapshot today; "india" (Kite) has none, so the
// gate is skipped there until an India NAV source exists.
export async function checkLivePortfolioLimits(opts: {
  supabase: any;
  market: "us" | "india";
  accountId: string;
  symbol: string;
  orderNotional: number; // candidate order value in the account currency
}): Promise<LivePortfolioGateResult> {
  const { supabase, market, accountId, symbol, orderNotional } = opts;

  if (market !== "us") return { ok: true, skipped: true, reason: "no live NAV source for this market" };
  if (!Number.isFinite(orderNotional) || orderNotional <= 0) return { ok: true, skipped: true, reason: "candidate notional unknown" };

  // Freshest snapshot for the trading account.
  const { data: snap } = await supabase.from("live_account_snapshots")
    .select("equity, positions_json, captured_at")
    .eq("account_id", accountId)
    .order("captured_at", { ascending: false }).limit(1).maybeSingle();

  const nav = Number((snap as any)?.equity);
  const capturedAt = (snap as any)?.captured_at ? Date.parse((snap as any).captured_at) : NaN;
  const fresh = Number.isFinite(capturedAt) && (Date.now() - capturedAt) <= SNAPSHOT_MAX_AGE_MS;
  if (!snap || !fresh || !Number.isFinite(nav) || nav <= 0) {
    return { ok: true, skipped: true, reason: "no fresh live NAV snapshot — portfolio limits not evaluated (notional caps still apply)" };
  }

  // Build the book: valuePct = position value (qty × avg cost) / NAV × 100. No sector in
  // the snapshot → null (constructor buckets these under UNKNOWN).
  const positions: any[] = Array.isArray((snap as any).positions_json) ? (snap as any).positions_json : [];
  const book: BookPosition[] = positions.map((p) => {
    const qty = Number(p.quantity ?? p.qty ?? 0);
    const cost = Number(p.average_buy_price ?? p.avg_price ?? p.avg_cost ?? 0);
    const value = qty * cost;
    return { symbol: String(p.symbol ?? p.ticker ?? "").toUpperCase(), sector: null, valuePct: nav > 0 ? (value / nav) * 100 : 0, beta: null, dailyVol: null };
  }).filter((b) => b.symbol);

  const candidate: CandidateOrder = {
    symbol: symbol.toUpperCase(),
    market: "us",
    proposedSizePct: (orderNotional / nav) * 100,
    sector: null, beta: null, dailyVol: null,
  };

  // Limits from strategy_config (fall back to the constructor defaults per field).
  const { data: cfg } = await supabase.from("strategy_config")
    .select("max_gross_exposure_pct, max_sector_exposure_pct, max_name_exposure_pct, max_portfolio_vol_pct, max_avg_pairwise_corr")
    .limit(1).maybeSingle();
  const limits: PortfolioLimits = {
    maxGrossExposurePct: Number((cfg as any)?.max_gross_exposure_pct) || DEFAULT_LIMITS.maxGrossExposurePct,
    maxSectorExposurePct: Number((cfg as any)?.max_sector_exposure_pct) || DEFAULT_LIMITS.maxSectorExposurePct,
    maxNameExposurePct: Number((cfg as any)?.max_name_exposure_pct) || DEFAULT_LIMITS.maxNameExposurePct,
    maxPortfolioVolPct: Number((cfg as any)?.max_portfolio_vol_pct) || DEFAULT_LIMITS.maxPortfolioVolPct,
    maxAvgPairwiseCorr: Number((cfg as any)?.max_avg_pairwise_corr) || DEFAULT_LIMITS.maxAvgPairwiseCorr,
  };

  const result = constructPortfolio(book, [candidate], limits);
  const sized = result.orders[0];
  // A human-approved live order should NOT be silently shrunk. If the constructor would
  // reduce or deny it, that means it breaches a portfolio limit → require re-approval.
  if (!sized || sized.finalSizePct < candidate.proposedSizePct - 1e-6) {
    return {
      ok: false,
      reason: sized?.finalSizePct === 0
        ? `would breach portfolio limits (position denied): ${(sized?.adjustments ?? []).join("; ")}`
        : `would exceed a portfolio limit (approved ${candidate.proposedSizePct.toFixed(1)}% of NAV, max allowed ${sized.finalSizePct.toFixed(1)}%): ${(sized.adjustments ?? []).join("; ")}`,
      adjustments: sized?.adjustments,
    };
  }
  return { ok: true };
}
