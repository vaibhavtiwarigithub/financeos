import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/service";

export const revalidate = 300; // 5 min — evidence/signals update at most twice a day

// Crypto's fundamentals-page analog. It must read the native crypto score that
// drives the paper book, not the equity ResearchAgent's incompatible composite.
// There is no P/E/earnings analogue; the displayed inputs are the frozen
// daily-candle trend, structure, volatility, and public-quote liquidity facts.
export async function GET(req: NextRequest) {
  const symbol = req.nextUrl.searchParams.get("symbol")?.toUpperCase().trim();
  if (!symbol) return NextResponse.json({ error: "symbol required" }, { status: 400 });

  const svc = createServiceClient();

  const [{ data: shadows }, { data: latestSignal }] = await Promise.all([
    svc.from("crypto_geometry_shadows")
      .select("observed_at, geometry, decision, refusal_reason")
      .eq("symbol", symbol).order("observed_at", { ascending: false }).limit(60),
    svc.from("agent_signals")
      .select("analyst_score, direction, rationale, created_at, status")
      .eq("market", "us").eq("score_source", "crypto_native_shadow_v1")
      .eq("symbol", symbol)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle(),
  ]);

  const rows = shadows ?? [];
  const latest = rows[0] ?? null;
  const sessionCount = new Set(rows.map((r: any) => String(r.observed_at).slice(0, 10))).size;
  const evidence = latest?.geometry?.evidence ?? {};
  const score = latest?.geometry?.score ?? null;
  const quote = latest?.geometry?.public_quote ?? null;

  return NextResponse.json({
    symbol,
    sessionCount,
    latestEvidenceAt: latest?.observed_at ?? null,
    trendScore: score?.components?.trend ?? null,
    structureScore: score?.components?.structure ?? null,
    volatilityScore: score?.components?.volatility ?? null,
    atrPct: evidence?.atrPct ?? null,
    publicQuoteSource: quote?.source ?? null,
    refusalReason: latest?.refusal_reason ?? null,
    analystScore: (latestSignal as any)?.analyst_score ?? null,
    direction: (latestSignal as any)?.direction ?? null,
    rationale: (latestSignal as any)?.rationale ?? null,
    signalStatus: (latestSignal as any)?.status ?? null,
    signalAt: (latestSignal as any)?.created_at ?? null,
  });
}
