// A signed-in user's OWN risk analytics.
//
// GET only, over already-persisted `user_*` rows. It calls nothing — no
// provider, no broker, no LLM — so it carries the same no-cost guarantee as the
// other viewer read routes and is swept by tests/viewer-route-sweep.test.ts.
//
// The user id comes from the session and is applied as an explicit filter on
// every query. RLS on these tables is the backstop; this filter is the
// mechanism. There is no parameter by which a caller can ask for someone
// else's rows, because the caller's identity is never read from the request.
import { NextRequest, NextResponse } from "next/server";
import { getSessionRole } from "@/lib/auth/session-role";
import { createServiceClient } from "@/lib/supabase/service";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const { role, userId } = await getSessionRole();
  if (!role || !userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const market = req.nextUrl.searchParams.get("market") === "us" ? "us" : "india";
  const svc = createServiceClient();

  // Latest run for THIS user in this market, whatever its status: a skipped run
  // is the answer when a Zerodha token expired overnight, and the page must be
  // able to say so rather than render an empty state that looks like "no risk".
  const { data: run } = await svc
    .from("user_holding_risk_runs")
    .select("id, status, skip_reason, as_of_date, started_at, completed_at, summary")
    .eq("user_id", userId)
    .eq("market", market)
    .order("started_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (!run) {
    return NextResponse.json({ market, run: null, holdings: [], history: [], symbolHistory: {} });
  }

  const { data: holdings } = await svc
    .from("user_holding_risk_snapshots")
    .select("symbol, as_of_date, metrics")
    .eq("user_id", userId)
    .eq("run_id", run.id)
    .order("symbol", { ascending: true });

  // Score history: the last 60 completed runs for this user+market, oldest
  // first. It is what makes a daily number mean anything — a 62 that was 40 a
  // week ago is a different situation from a 62 that has sat there. Read from
  // the runs already written; no new storage, and no backfill that would invent
  // history that was never computed.
  const { data: historyRows } = await svc
    .from("user_holding_risk_runs")
    .select("as_of_date, started_at, summary")
    .eq("user_id", userId)
    .eq("market", market)
    .eq("status", "ok")
    .order("started_at", { ascending: false })
    .limit(60);

  const history = (historyRows ?? [])
    .map((r: any) => ({
      asOfDate: r.as_of_date,
      at: r.started_at,
      riskScore: Number(r.summary?.riskScore ?? NaN),
      totalValue: Number(r.summary?.totalValue ?? NaN),
    }))
    .filter((p: { riskScore: number }) => Number.isFinite(p.riskScore))
    .reverse();

  // Per-symbol score history, for "why this holding and how has it moved".
  // Keyed by symbol so the page can chart one line per holding without a
  // second round trip.
  const { data: symbolRows } = await svc
    .from("user_holding_risk_snapshots")
    .select("symbol, as_of_date, metrics")
    .eq("user_id", userId)
    .eq("market", market)
    .order("as_of_date", { ascending: true })
    .limit(2000);

  const symbolHistory: Record<string, Array<{ asOfDate: string | null; weightPct: number; beta: number }>> = {};
  for (const r of symbolRows ?? []) {
    const sym = String((r as any).symbol);
    (symbolHistory[sym] ||= []).push({
      asOfDate: (r as any).as_of_date,
      weightPct: Number((r as any).metrics?.weightPct ?? 0),
      beta: Number((r as any).metrics?.beta ?? 0),
    });
  }

  return NextResponse.json({
    market,
    history,
    symbolHistory,
    run: {
      status: run.status,
      skipReason: run.skip_reason,
      asOfDate: run.as_of_date,
      startedAt: run.started_at,
      completedAt: run.completed_at,
      summary: run.summary,
    },
    holdings: holdings ?? [],
  });
}
