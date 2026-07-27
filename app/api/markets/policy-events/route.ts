import { NextResponse } from "next/server";
import { requireOwner } from "@/lib/auth/require-owner";
import { createServiceClient } from "@/lib/supabase/service";

export const dynamic = "force-dynamic";

export async function GET() {
  const gate = await requireOwner();
  if (gate) return gate;
  const svc = createServiceClient();
  const { data: events, error } = await svc
    .from("policy_rate_events")
    .select("id,scheduled_date,status,actual_effective_date,actual_target_lower,actual_target_upper,actual_source,surprise_bps,official_source_url")
    .eq("authority", "fomc")
    .order("scheduled_date", { ascending: false })
    .limit(12);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const ids = (events ?? []).map((event: any) => event.id);
  const [expectationsResult, impactsResult] = ids.length ? await Promise.all([
    svc.from("policy_rate_expectation_snapshots")
      .select("event_id,captured_at,expected_target_lower,expected_target_upper,source_name,source_url")
      .in("event_id", ids)
      .order("captured_at", { ascending: false }),
    svc.from("policy_event_impacts")
      .select("event_id,symbol,horizon_sessions,symbol_return_pct,benchmark_return_pct,excess_return_pct,first_session_date,last_session_date,created_at")
      .in("event_id", ids)
      .order("created_at", { ascending: false })
      .limit(2000),
  ]) : [{ data: [] }, { data: [] }];
  if (expectationsResult.error) return NextResponse.json({ error: expectationsResult.error.message }, { status: 500 });
  if (impactsResult.error) return NextResponse.json({ error: impactsResult.error.message }, { status: 500 });

  const expectationByEvent = new Map<string, any>();
  for (const row of expectationsResult.data ?? []) {
    if (!expectationByEvent.has((row as any).event_id)) expectationByEvent.set((row as any).event_id, row);
  }
  const seenImpact = new Set<string>();
  const impactsByEvent = new Map<string, any[]>();
  for (const row of impactsResult.data ?? []) {
    const impact = row as any;
    const key = `${impact.event_id}|${impact.symbol}|${impact.horizon_sessions}`;
    if (seenImpact.has(key)) continue;
    seenImpact.add(key);
    const values = impactsByEvent.get(impact.event_id) ?? [];
    values.push(impact);
    impactsByEvent.set(impact.event_id, values);
  }

  const items = (events ?? []).map((event: any) => {
    const impacts = impactsByEvent.get(event.id) ?? [];
    const impactSummary = [1, 5].map((horizon) => {
      const candidates = impacts
        .filter((impact) => impact.horizon_sessions === horizon && impact.excess_return_pct != null)
        .sort((a, b) => Math.abs(Number(b.excess_return_pct)) - Math.abs(Number(a.excess_return_pct)));
      return {
        horizon_sessions: horizon,
        observed_symbols: impacts.filter((impact) => impact.horizon_sessions === horizon).length,
        largest_excess: candidates.slice(0, 3),
      };
    });
    return { ...event, expectation: expectationByEvent.get(event.id) ?? null, impact_summary: impactSummary };
  });
  return NextResponse.json({
    market: "us",
    expectation_source: "unconfigured",
    items,
    note: "Record-only context. It does not change scoring, paper trading, live trading, or position exits.",
  });
}
