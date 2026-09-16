import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/service";

export const revalidate = 300; // 5 min — evidence/signals update at most twice a day

// Crypto's fundamentals-page analog. There is no P/E, no earnings, no analyst
// coverage — the composite is technical + macro (+ sentiment when available),
// same renormalized mechanism ETFs use (lib/scoring/instrument-taxonomy.ts,
// FEATURE_ARCHITECTURE.md §2.3). Reads the same evidence ResearchAgent already
// writes; no new provider call.
export async function GET(req: NextRequest) {
  const symbol = req.nextUrl.searchParams.get("symbol")?.toUpperCase().trim();
  if (!symbol) return NextResponse.json({ error: "symbol required" }, { status: 400 });

  const svc = createServiceClient();

  const [{ data: evidenceRows }, { data: latestSignal }] = await Promise.all([
    svc.from("instrument_family_observations")
      .select("created_at, features")
      .eq("instrument_family", "crypto")
      .eq("symbol", symbol)
      .order("created_at", { ascending: false })
      .limit(60),
    svc.from("agent_signals")
      .select("analyst_score, direction, rationale, created_at, status")
      .eq("market", "us")
      .eq("symbol", symbol)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle(),
  ]);

  const rows = evidenceRows ?? [];
  const latest = rows[0] ?? null;
  const sessionCount = new Set(rows.map((r: any) => String(r.created_at).slice(0, 10))).size;
  const f = latest?.features ?? {};

  return NextResponse.json({
    symbol,
    sessionCount,
    latestEvidenceAt: latest?.created_at ?? null,
    technicalScore: f.technical_score_v1?.value ?? null,
    realYieldChange20obsPp: f.real_yield_10y_change_20obs_pp?.value ?? null,
    dollarChange20obsIndexPoints: f.broad_dollar_change_20obs_index_points?.value ?? null,
    analystScore: (latestSignal as any)?.analyst_score ?? null,
    direction: (latestSignal as any)?.direction ?? null,
    rationale: (latestSignal as any)?.rationale ?? null,
    signalStatus: (latestSignal as any)?.status ?? null,
    signalAt: (latestSignal as any)?.created_at ?? null,
  });
}
