import { NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/service";
import { requireOwner } from "@/lib/auth/require-owner";

export const dynamic = "force-dynamic";

const DIMS = ["sector_awareness", "emotional_discipline", "risk_management", "thesis_quality", "entry_timing", "big_picture"] as const;

export async function GET() {
  const gate = await requireOwner();
  if (gate) return gate;
  const svc = createServiceClient();

  // Last 90 days of dimension logs
  const since = new Date(Date.now() - 90 * 86400_000).toISOString().slice(0, 10);
  const { data: rows, error } = await svc
    .from("mentor_dimension_logs")
    .select("evaluated_at, sector_awareness, emotional_discipline, risk_management, thesis_quality, entry_timing, big_picture, observations, trade_symbol")
    .gte("evaluated_at", since)
    .order("evaluated_at", { ascending: true });

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  // Overall averages (last 30 days for radar)
  const recent30 = (rows ?? []).filter((r: any) => r.evaluated_at >= new Date(Date.now() - 30 * 86400_000).toISOString().slice(0, 10));
  const averages: Record<string, number> = {};
  for (const dim of DIMS) {
    const vals = recent30.map((r: any) => (r as any)[dim]).filter((v: any) => v != null);
    averages[dim] = vals.length > 0 ? Math.round(vals.reduce((a: number, b: number) => a + b, 0) / vals.length) : 50;
  }

  // Time series — daily avg per dimension
  const byDate: Record<string, Record<string, number[]>> = {};
  for (const row of rows ?? []) {
    const d = row.evaluated_at;
    if (!byDate[d]) byDate[d] = {};
    for (const dim of DIMS) {
      if (!byDate[d][dim]) byDate[d][dim] = [];
      byDate[d][dim].push((row as any)[dim] ?? 50);
    }
  }
  const timeSeries = Object.entries(byDate).map(([date, dims]) => {
    const point: Record<string, unknown> = { date };
    for (const [dim, vals] of Object.entries(dims)) {
      point[dim] = Math.round(vals.reduce((a, b) => a + b, 0) / vals.length);
    }
    return point;
  });

  // Weakest dimension (lowest avg over last 30 days)
  const weakest = DIMS.reduce((a, b) => averages[a] <= averages[b] ? a : b);
  const strongest = DIMS.reduce((a, b) => averages[a] >= averages[b] ? a : b);

  // Latest observations for weakest (coach insight)
  const latestObs = (rows ?? [])
    .filter((r: any) => r.observations && (r.observations as any)[weakest])
    .slice(-5)
    .map((r: any) => ({ symbol: r.trade_symbol, date: r.evaluated_at, text: (r.observations as any)[weakest] }));

  return NextResponse.json({ averages, timeSeries, weakest, strongest, latestObs, total: rows?.length ?? 0 });
}
