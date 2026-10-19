import { NextRequest, NextResponse } from "next/server";
import { requireOwner } from "@/lib/auth/require-owner";
import { createServiceClient } from "@/lib/supabase/service";
import { covarianceSizingShadowEventReason } from "@/lib/portfolio/correlation-shadow";

export const dynamic = "force-dynamic";

function finite(value: unknown): number | null {
  if (value == null || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

type CovarianceEvent = {
  symbol: string;
  state: string;
  reason: string | null;
  createdAt: string;
  decisionAt: string | null;
  signalId: string | null;
  baselineSizePct: number | null;
  counterfactualSizePct: number | null;
  baselineDailyVolPct: number | null;
  counterfactualDailyVolPct: number | null;
  maxPortfolioDailyVolPct: number | null;
  sizeReductionPct: number | null;
  commonSessions: number | null;
  firstSession: string | null;
  lastSession: string | null;
  priceBasis: string | null;
  shrinkage: number | null;
  evidenceFingerprint: string | null;
};

/** Owner-only read surface for the measure-only covariance sizing shadow. */
export async function GET(req: NextRequest) {
  const gate = await requireOwner();
  if (gate) return gate;

  const market = req.nextUrl.searchParams.get("market");
  if (market !== "us" && market !== "india") {
    return NextResponse.json({ error: "market must be us or india" }, { status: 400 });
  }

  const since = new Date(Date.now() - 30 * 86_400_000).toISOString();
  const svc = createServiceClient();
  const { data, error } = await svc.from("pipeline_stage_events")
    .select("symbol,outcome,reason,detail,created_at,signal_id")
    .eq("market", market)
    .eq("stage", "covariance_sizing_shadow")
    .gte("created_at", since)
    .order("created_at", { ascending: false })
    .limit(100);
  if (error) {
    console.error("[portfolio/covariance-shadow] read failed:", error.message);
    return NextResponse.json({ error: "Covariance shadow evidence is unavailable." }, { status: 503 });
  }

  const events: CovarianceEvent[] = (data ?? []).map((row: any): CovarianceEvent => {
    const detail = row.detail && typeof row.detail === "object" ? row.detail : {};
    const state = String(row.outcome ?? "unmeasurable");
    const sizeReductionPct = finite(detail.sizeReductionPct);
    return {
      symbol: String(row.symbol ?? detail.candidate ?? "UNKNOWN"),
      state,
      // Repair the known historical mislabel at read time too. The append-only
      // event remains untouched; its detail is the source for the actual result.
      reason: state === "measured" && row.reason === "return_panel_unavailable"
        ? covarianceSizingShadowEventReason({ state, reason: detail.reason, sizeReductionPct })
        : row.reason == null ? null : String(row.reason),
      createdAt: String(row.created_at),
      decisionAt: detail.decisionAt == null ? null : String(detail.decisionAt),
      signalId: row.signal_id == null ? null : String(row.signal_id),
      baselineSizePct: finite(detail.baselineSizePct ?? detail.baseline_size_pct),
      counterfactualSizePct: finite(detail.counterfactualSizePct),
      baselineDailyVolPct: finite(detail.baselineDailyVolPct),
      counterfactualDailyVolPct: finite(detail.counterfactualDailyVolPct),
      maxPortfolioDailyVolPct: finite(detail.maxPortfolioDailyVolPct),
      sizeReductionPct,
      commonSessions: finite(detail.commonSessions),
      firstSession: detail.firstSession == null ? null : String(detail.firstSession),
      lastSession: detail.lastSession == null ? null : String(detail.lastSession),
      priceBasis: detail.priceBasis == null ? null : String(detail.priceBasis),
      shrinkage: finite(detail.shrinkage),
      evidenceFingerprint: detail.evidenceFingerprint == null ? null : String(detail.evidenceFingerprint),
    };
  });
  const measured = events.filter((event) => event.state === "measured");
  const reductions = measured.map((event) => event.sizeReductionPct).filter((value): value is number => value != null);
  const average = (values: number[]) => values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;

  return NextResponse.json({
    market,
    generatedAt: new Date().toISOString(),
    windowStart: since,
    summary: {
      events: events.length,
      measured: measured.length,
      unmeasurable: events.length - measured.length,
      riskTrimmed: reductions.filter((value) => value > 0.0001).length,
      averageSizeReductionPct: average(reductions),
      averageBaselineDailyVolPct: average(measured.map((event) => event.baselineDailyVolPct).filter((value): value is number => value != null)),
      averageCounterfactualDailyVolPct: average(measured.map((event) => event.counterfactualDailyVolPct).filter((value): value is number => value != null)),
    },
    events,
    boundary: "measure-only; does not affect paper/live sizing, eligibility, ranking, orders or exits",
  }, { headers: { "Cache-Control": "no-store" } });
}
