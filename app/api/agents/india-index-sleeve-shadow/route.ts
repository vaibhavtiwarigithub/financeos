import { NextRequest, NextResponse } from "next/server";
import { requireOwner } from "@/lib/auth/require-owner";
import { verifyCronSecret } from "@/lib/auth/cron";
import { createServiceClient } from "@/lib/supabase/service";
import { fetchAllRows } from "@/lib/supabase/paginate";
import { SLEEVE_METHOD, SLEEVE_WEIGHTS, extendBlend, type SleeveRow } from "@/lib/india-index-sleeve";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

// Measure-only India index-ETF sleeve shadow: extends, per sleeve weight, the NAV the India paper book would have had with that share of
// capital in NIFTYBEES (daily-rebalanced). Reads stored EOD book NAVs and the NIFTYBEES series; writes append-only india_sleeve_shadow_nav.
// No orders, no capital moved, no trading path reads it. Idempotent: each run only appends sessions after the last stored row.

export async function GET(req: NextRequest) {
  const cron = verifyCronSecret(req);
  if (!cron) {
    const gate = await requireOwner();
    if (gate) return gate;
  }
  const svc = createServiceClient();
  const runId = `india-index-sleeve-shadow:${new Date().toISOString()}`;

  const perf = await fetchAllRows((from, to) => svc.from("paper_performance").select("id,date,nav")
    .eq("market", "india").eq("snapshot_type", "eod").eq("tainted", false).order("date", { ascending: true }).order("id", { ascending: true }).range(from, to), "sleeve book nav") as any[];
  const book = perf.map((r) => ({ date: String(r.date), nav: Number(r.nav) }));

  const etfRows = await fetchAllRows((from, to) => svc.from("india_macro_observations").select("id,obs_date,value")
    .eq("series_id", "niftybees_close").order("id", { ascending: true }).range(from, to), "sleeve etf closes") as any[];
  const etf = new Map<string, number>(etfRows.map((r) => [String(r.obs_date), Number(r.value)] as const));
  if (!book.length || !etf.size) return NextResponse.json({ ok: true, skipped: "no_book_or_etf_series", book: book.length, etf: etf.size, shadowOnly: true });

  const written: Record<string, number> = {};
  for (const weight of SLEEVE_WEIGHTS) {
    const { data: lastRows, error: lastErr } = await svc.from("india_sleeve_shadow_nav").select("as_of_date,weight,blended_nav,book_nav,etf_close")
      .eq("method", SLEEVE_METHOD).eq("weight", weight).order("as_of_date", { ascending: false }).limit(1);
    if (lastErr) return NextResponse.json({ ok: false, error: `could not read last sleeve row: ${lastErr.message}` }, { status: 500 });
    const last = lastRows?.[0];
    const prior: SleeveRow | null = last ? { as_of_date: String(last.as_of_date), weight, blended_nav: Number(last.blended_nav), book_nav: Number(last.book_nav), etf_close: Number(last.etf_close) } : null;
    const rows = extendBlend(book, etf, weight, prior);
    written[String(weight)] = 0;
    for (let i = 0; i < rows.length; i += 200) {
      const chunk = rows.slice(i, i + 200).map((r) => ({ as_of_date: r.as_of_date, weight, method: SLEEVE_METHOD, blended_nav: r.blended_nav, book_nav: r.book_nav, etf_close: r.etf_close, run_id: runId }));
      const { data, error } = await svc.from("india_sleeve_shadow_nav").upsert(chunk, { onConflict: "as_of_date,weight,method", ignoreDuplicates: true }).select("id");
      if (error) return NextResponse.json({ ok: false, error: `sleeve write failed: ${error.message}`, written }, { status: 500 });
      written[String(weight)] += data?.length ?? 0;
    }
  }

  await svc.from("agent_runs").insert({
    agent_type: "india_index_sleeve_shadow", status: "done", market: "india", symbols: [], trigger_source: cron ? "scheduled" : "manual",
    signals_written: 0, completed_at: new Date().toISOString(), tokens_input: 0, tokens_output: 0, claude_calls: 0,
    result_summary: `Shadow only: appended ${Object.entries(written).map(([w, n]) => `w${w}=${n}`).join(", ")} sessions; no orders, no capital moved; behavior changed=false`,
  });
  return NextResponse.json({ ok: true, shadowOnly: true, behaviorChanged: false, bookSessions: book.length, etfSessions: etf.size, written });
}

export const POST = GET;
