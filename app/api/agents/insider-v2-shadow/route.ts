import { NextRequest, NextResponse } from "next/server";
import { requireOwner } from "@/lib/auth/require-owner";
import { verifyCronSecret } from "@/lib/auth/cron";
import { createServiceClient } from "@/lib/supabase/service";
import { SEC_UA, buildForm4XmlUrl, getTickerCikMap } from "@/lib/data/edgar-insider";
import { parseForm4Detailed, scoreInsiderV1V2, type Form4Filing } from "@/lib/data/insider-v2";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

// Measure-only. For each US symbol researched in the last 4 days, read the SEC Form 4s of the past 90 days ONCE and append both the live
// insider logic (v1) and the planned-sale-ignoring variant (v2) to insider_v2_shadow. Nothing in scoring, gates or trading reads the table.
// Runs several times per morning; each run resumes where the last stopped (symbols already stored for today are skipped).

const LOOKBACK_DAYS = 90;
const MAX_FILINGS = 8; // same cap as the live EDGAR scorer
const TIME_BUDGET_MS = 95_000;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function filingsFor(cik: string): Promise<{ filings: Form4Filing[]; attempted: number; failed: number }> {
  const sub = await fetch(`https://data.sec.gov/submissions/CIK${cik}.json`, { headers: { "User-Agent": SEC_UA } });
  if (!sub.ok) return { filings: [], attempted: 1, failed: 1 };
  const recent = (await sub.json()).filings?.recent ?? {};
  const forms: string[] = recent.form ?? []; const dates: string[] = recent.filingDate ?? [];
  const acc: string[] = recent.accessionNumber ?? []; const docs: string[] = recent.primaryDocument ?? [];
  const cutoff = new Date(Date.now() - LOOKBACK_DAYS * 86400_000).toISOString().slice(0, 10);
  const idx = forms.map((f, i) => ({ f, i })).filter(({ f, i }) => f === "4" && dates[i] >= cutoff).slice(0, MAX_FILINGS).map(({ i }) => i);
  const filings: Form4Filing[] = []; let attempted = 0; let failed = 0;
  for (const i of idx) {
    const url = buildForm4XmlUrl(cik, acc[i], docs[i]);
    if (!url) continue;
    attempted++;
    try {
      const res = await fetch(url, { headers: { "User-Agent": SEC_UA } });
      if (!res.ok) { failed++; continue; }
      filings.push(parseForm4Detailed(await res.text()));
    } catch { failed++; }
    await sleep(120); // SEC fair use ~10 req/s
  }
  return { filings, attempted, failed };
}

export async function GET(req: NextRequest) {
  const cron = verifyCronSecret(req);
  if (!cron) {
    const gate = await requireOwner();
    if (gate) return gate;
  }
  const started = Date.now();
  const svc = createServiceClient();
  const today = new Date().toISOString().slice(0, 10);

  const since = new Date(Date.now() - 4 * 86400_000).toISOString();
  const { data: obs, error: obsError } = await svc.from("decision_observations").select("symbol").eq("market", "us").gte("ts", since).limit(5000);
  if (obsError) return NextResponse.json({ ok: false, error: obsError.message }, { status: 500 });
  const universe: string[] = [...new Set<string>((obs ?? []).map((o: any) => String(o.symbol).toUpperCase()))].sort();
  const { data: done } = await svc.from("insider_v2_shadow").select("symbol").eq("as_of", today);
  const doneSet = new Set((done ?? []).map((d: any) => d.symbol));
  const todo = universe.filter((s) => !doneSet.has(s));

  let cikMap: Map<string, string>;
  try { cikMap = await getTickerCikMap(); } catch (e) { return NextResponse.json({ ok: false, error: `CIK map unavailable: ${e instanceof Error ? e.message : String(e)}` }, { status: 502 }); }

  let written = 0; let noCik = 0;
  for (const symbol of todo) {
    if (Date.now() - started > TIME_BUDGET_MS) break;
    const cik = cikMap.get(symbol);
    if (!cik) { noCik++; continue; } // ETFs, ADRs and non-US names have no Form 4s: nothing to store
    const { filings, attempted, failed } = await filingsFor(cik);
    if (attempted > 0 && failed === attempted) continue; // unreadable is not evidence: retry on a later run
    const r = scoreInsiderV1V2(filings);
    const { error } = await svc.from("insider_v2_shadow").upsert({
      symbol, as_of: today, lookback_days: LOOKBACK_DAYS, filings_attempted: attempted, filings_failed: failed,
      buy_count: r.buyCount, buy_value: r.buyValue, planned_sell_count: r.plannedSellCount, planned_sell_value: r.plannedSellValue,
      discretionary_sell_count: r.discretionarySellCount, discretionary_sell_value: r.discretionarySellValue, unknown_sell_count: r.unknownSellCount, unknown_sell_value: r.unknownSellValue,
      v1_score: r.v1Score, v1_available: r.v1Available, v2_score: r.v2Score, v2_available: r.v2Available,
    }, { onConflict: "symbol,as_of", ignoreDuplicates: true });
    if (error) return NextResponse.json({ ok: false, error: `write failed for ${symbol}: ${error.message}`, written }, { status: 500 });
    written++;
  }

  await svc.from("agent_runs").insert({
    agent_type: "insider_v2_shadow", status: "done", market: "us", symbols: [], trigger_source: cron ? "scheduled" : "manual",
    signals_written: 0, completed_at: new Date().toISOString(), tokens_input: 0, tokens_output: 0, claude_calls: 0,
    result_summary: `Shadow only: ${written} symbols stored, ${noCik} without SEC CIK, ${todo.length - written - noCik} left for later runs; behavior changed=false`,
  });
  return NextResponse.json({ ok: true, shadowOnly: true, behaviorChanged: false, universe: universe.length, written, noCik, remaining: todo.length - written - noCik });
}

export const POST = GET;
