import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/service";
import { verifyCronSecret } from "@/lib/auth/cron";
import { providerCachedFetch } from "@/lib/data/provider-fetch";
import { assessCorporateActionPayload, symbolsNeedingCoverage, type CorporateActionKind } from "@/lib/shadows/corporate-action-coverage";
import { massiveActionPath, normalizeMassiveActions } from "@/lib/shadows/massive-corporate-actions";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

// POST /api/agents/corporate-action-coverage?market=us
//
// Evidence collector for the ATR forward replay's corporate-action gate. It
// records, per symbol and action type, that a provider response was actually
// fetched and validated (coverage) and stores the events (ledger). It touches
// no order, score, position or paper-ledger path.
//
// US only: Massive has no NSE coverage, and Alpha Vantage's 25/day cap cannot
// certify a whole book, so India stays uncovered and its replay stays blocked.
// Massive is hard-paced to 5 calls/minute, so one invocation certifies at most
// two symbols (four calls); the schedule runs it repeatedly and coverage is only
// re-fetched once it is older than COVERAGE_REFRESH_DAYS.
const COVERAGE_REFRESH_DAYS = 5;
const SYMBOLS_PER_RUN = 2;
const HISTORY_DAYS = 120;
const MIN_CALL_GAP_MS = 12_600;
const ENTRY_LOOKBACK_DAYS = 10;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export async function POST(req: NextRequest) {
  if (!verifyCronSecret(req)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const market = new URL(req.url).searchParams.get("market");
  if (market !== "us") {
    return NextResponse.json({ error: "Only market=us has a corporate-action source; India replay stays blocked.", persisted: false }, { status: 400 });
  }
  const apiKey = process.env.MASSIVE_API_KEY ?? "";
  if (!apiKey) return NextResponse.json({ error: "No MASSIVE_API_KEY", persisted: false }, { status: 500 });

  const svc = createServiceClient();
  const now = new Date();
  const entrySince = new Date(now.getTime() - ENTRY_LOOKBACK_DAYS * 86_400_000).toISOString();
  const [positions, entries] = await Promise.all([
    svc.from("paper_positions").select("symbol").eq("market", "us").is("exit_reason", null).gt("qty", 0).limit(500),
    svc.from("paper_trades").select("symbol").eq("market", "us").eq("order_side", "buy").gte("executed_at", entrySince).limit(500),
  ]);
  if (positions.error || entries.error) {
    return NextResponse.json({ error: `Scope read failed: ${positions.error?.message ?? entries.error?.message}`, persisted: false }, { status: 503 });
  }
  const candidates = [...new Set([...(positions.data ?? []), ...(entries.data ?? [])].map((row: any) => String(row.symbol).toUpperCase()))];
  if (!candidates.length) return NextResponse.json({ ok: true, persisted: false, note: "No US paper positions or recent entries in scope." });

  const priorRead = await svc.from("corporate_action_source_coverage")
    .select("symbol,action_type,status,checked_at")
    .in("symbol", candidates)
    .order("checked_at", { ascending: false })
    .limit(5000);
  if (priorRead.error) return NextResponse.json({ error: `Coverage ledger unavailable: ${priorRead.error.message}`, persisted: false }, { status: 503 });

  const symbols = symbolsNeedingCoverage(candidates, priorRead.data ?? [], now, COVERAGE_REFRESH_DAYS, SYMBOLS_PER_RUN);
  if (!symbols.length) return NextResponse.json({ ok: true, persisted: false, note: "All in-scope symbols have fresh complete coverage.", candidates: candidates.length });

  const since = new Date(now.getTime() - HISTORY_DAYS * 86_400_000).toISOString().slice(0, 10);
  const results: Array<{ symbol: string; kind: CorporateActionKind; status: string; records: number; reason: string | null }> = [];
  let lastCallAt = 0;

  for (const symbol of symbols) {
    for (const kind of ["split", "dividend"] as const) {
      const wait = lastCallAt + MIN_CALL_GAP_MS - Date.now();
      if (lastCallAt && wait > 0) await sleep(wait);
      const cacheKey = `MASSIVE_ACTIONS:${kind}:${symbol}`;
      const url = `https://api.massive.com${massiveActionPath(kind, symbol, since)}&apiKey=${apiKey}`;
      const payload = await providerCachedFetch("massive", cacheKey, url, { timeoutMs: 8000 });
      lastCallAt = Date.now();

      const { data: cacheRow } = await svc.from("av_cache").select("fetched_at").eq("cache_key", cacheKey).order("cache_date", { ascending: false }).limit(1).maybeSingle();
      const fetchedAt = (cacheRow as { fetched_at?: string } | null)?.fetched_at ?? null;
      const normalized = payload == null ? null : normalizeMassiveActions(kind, payload);
      const assessment = payload == null
        ? { status: "error" as const, recordsCount: 0, reason: "Provider returned no payload (request failed, throttled or paced)." }
        : normalized == null
          ? { status: "invalid" as const, recordsCount: 0, reason: "Provider payload could not certify a complete, unambiguous event list." }
          : assessCorporateActionPayload({ kind, payload: normalized, providerFetchedAt: fetchedAt, maxAgeDays: 7 });

      const { error: coverageError } = await svc.from("corporate_action_source_coverage").insert({
        symbol, action_type: kind, source: "massive", status: assessment.status,
        provider_fetched_at: fetchedAt, records_count: assessment.recordsCount, details: { reason: assessment.reason, since },
      });
      if (coverageError) return NextResponse.json({ error: `Could not persist ${kind} coverage for ${symbol}: ${coverageError.message}`, persisted: false, results }, { status: 500 });
      results.push({ symbol, kind, status: assessment.status, records: assessment.recordsCount, reason: assessment.reason });

      if (assessment.status !== "complete" || !normalized) continue;
      for (const row of normalized.data) {
        const record = kind === "split"
          ? { symbol, action_type: "split", ex_date: String(row.effective_date), split_ratio: Number(row.split_factor), source: "massive", source_tier: 2 }
          : { symbol, action_type: "dividend", ex_date: String(row.ex_dividend_date), dividend_amount: Number(row.amount), dividend_type: "regular", source: "massive", source_tier: 2 };
        const { error } = await svc.from("corporate_actions").upsert(record, { onConflict: "symbol,action_type,ex_date" });
        if (error) return NextResponse.json({ error: `Could not persist ${kind} event for ${symbol}: ${error.message}`, persisted: false, results }, { status: 500 });
      }
    }
  }

  const ok = results.every((row) => row.status === "complete");
  return NextResponse.json({ ok, persisted: true, market, symbols, results });
}
