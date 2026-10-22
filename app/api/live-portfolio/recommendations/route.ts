// GET /api/live-portfolio/recommendations
//
// Stored rows only (no broker, model or provider call): every recommendation shown for the live book with its latest mark, plus the Guardian
// scorecard and the latest daily revision note. Owner only: it exposes the owner's account symbols, response and P/L. Display only.
import { NextResponse } from "next/server";
import { requireOwner } from "@/lib/auth/require-owner";
import { createServiceClient } from "@/lib/supabase/service";
import { fetchAllRows } from "@/lib/supabase/paginate";
import { loadGuardianOutcomeScorecard } from "@/lib/live-recommendations/guardian-store";

export const dynamic = "force-dynamic";

export async function GET() {
  const gate = await requireOwner();
  if (gate) return gate;
  const svc = createServiceClient();
  try {
    const recs = await fetchAllRows((f, t) => svc.from("live_recommendations").select("id,kind,account_id,symbol,issued_at,reference_price,level_price,qty_suggested,horizon_sessions,rationale").eq("market", "us").order("id", { ascending: true }).range(f, t), "recommendations") as any[];
    const marks = await fetchAllRows((f, t) => svc.from("live_recommendation_marks").select("id,rec_id,marked_on,status,response_account,response_detail,sessions_since,last_price,symbol_return_pct,benchmark_return_pct,excess_pct,pnl_pct,pnl_basis,level_touched,level_touched_on,pnl_if_level_pct").order("id", { ascending: true }).range(f, t), "marks") as any[];
    const latest = new Map<number, any>();
    for (const m of marks) { const cur = latest.get(m.rec_id); if (!cur || m.marked_on >= cur.marked_on) latest.set(m.rec_id, m); }
    const { data: rev } = await svc.from("live_guardian_revisions").select("revised_on,sample,distinct_symbols,arms,note").order("revised_on", { ascending: false }).limit(1);
    const { count: planEvents } = await svc.from("guardian_protection_events").select("id", { count: "exact", head: true });
    const rows = recs.map((r) => ({ ...r, mark: latest.get(r.id) ?? null })).sort((a, b) => Date.parse(b.issued_at) - Date.parse(a.issued_at));
    const guardianOutcomes = await loadGuardianOutcomeScorecard(svc, "us");
    return NextResponse.json({ displayOnly: true, asOf: [...latest.values()].reduce((m, x) => (x.marked_on > m ? x.marked_on : m), ""), rows, revision: rev?.[0] ?? null, guardianPlanEvents: planEvents ?? 0, guardianOutcomes }, { headers: { "Cache-Control": "private, no-store" } });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "recommendations unavailable" }, { status: 500 });
  }
}
