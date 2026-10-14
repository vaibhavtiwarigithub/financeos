// GET /api/learning/index-sleeve
//
// India index-ETF sleeve SHADOW evidence for the Learning page, viewer-safe aggregates only: per sleeve weight the blended NAV's return,
// volatility and drawdown against the real book, plus how the book moves against NIFTYBEES (beta, capture, tracking error). Stored rows
// only; no model or provider call. Nothing here allocates capital.
import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/service";
import { requireViewerOrOwner } from "@/lib/auth/session-role";
import { fetchAllRows } from "@/lib/supabase/paginate";
import { SLEEVE_METHOD, SLEEVE_WEIGHTS, bookVsEtf, pathMetrics, sleeveEvidenceState } from "@/lib/india-index-sleeve";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const { gate } = await requireViewerOrOwner(req);
  if (gate) return gate;
  const svc = createServiceClient();
  let rows: any[] = [];
  try {
    rows = await fetchAllRows((from, to) => svc.from("india_sleeve_shadow_nav").select("id,as_of_date,weight,blended_nav,book_nav,etf_close,computed_at")
      .eq("method", SLEEVE_METHOD).order("id", { ascending: true }).range(from, to), "sleeve shadow rows") as any[];
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "sleeve shadow unavailable" }, { status: 500 });
  }
  if (!rows.length) return NextResponse.json({ market: "india", shadowOnly: true, sessions: 0, state: { state: "collecting", text: "No sleeve shadow rows yet." }, weights: [], book: null, bookVsEtf: null });

  const byWeight = new Map<number, any[]>();
  for (const r of rows) { const w = Number(r.weight); const l = byWeight.get(w) ?? []; l.push(r); byWeight.set(w, l); }
  const base = byWeight.get(SLEEVE_WEIGHTS[0]) ?? [];
  base.sort((a, b) => String(a.as_of_date).localeCompare(String(b.as_of_date)));
  const bookMetrics = pathMetrics(base.map((r) => Number(r.book_nav)));
  const vs = bookVsEtf(base.map((r) => ({ as_of_date: String(r.as_of_date), book_nav: Number(r.book_nav), etf_close: Number(r.etf_close) })));

  const weights = SLEEVE_WEIGHTS.map((w) => {
    const list = (byWeight.get(w) ?? []).sort((a, b) => String(a.as_of_date).localeCompare(String(b.as_of_date)));
    const m = pathMetrics(list.map((r) => Number(r.blended_nav)));
    return { weight: w, sessions: list.length, metrics: m };
  });
  const state = sleeveEvidenceState(vs?.sessions ?? 0, vs?.etfTotalReturnPct ?? 0, vs?.upDays ?? 0, vs?.downDays ?? 0);
  return NextResponse.json({
    market: "india", shadowOnly: true, instrument: "NIFTYBEES.NS", method: SLEEVE_METHOD,
    firstDate: base[0]?.as_of_date ?? null, lastDate: base[base.length - 1]?.as_of_date ?? null, sessions: vs?.sessions ?? 0,
    state, book: bookMetrics, bookVsEtf: vs, weights,
  });
}
