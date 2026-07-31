import { createHash } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { requireOwner } from "@/lib/auth/require-owner";
import { verifyCronSecret } from "@/lib/auth/cron";
import { createServiceClient } from "@/lib/supabase/service";
import { fetchGoogleNewsHeadlines } from "@/lib/india-news-shadow";
import { fetchNseCorporateAnnouncements, type CorporateAnnouncement } from "@/lib/nse-data";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const RSS_INTENT = "sentiment.news_headlines_shadow";
const NSE_INTENT = "event.corporate_announcement_shadow";
const RSS_PROVIDER = "google_news_rss";
const NSE_PROVIDER = "nse_corporate_announcements";
const CONTRACT = "india-news-shadow-v1";
const MAX_SYMBOLS = 20;

const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

async function ledger(svc: any, row: Record<string, unknown>): Promise<void> {
  const { error } = await svc.from("provider_call_ledger").insert(row);
  if (error) throw new Error(`provider ledger write failed: ${error.message}`);
}

async function cacheEvidence(svc: any, args: {
  symbol: string; intent: string; provider: string; payload: unknown; observedAt?: string | null; quality: "fresh" | "partial";
}): Promise<void> {
  const now = new Date();
  const requestFingerprint = hash({ contract: CONTRACT, market: "india", symbol: args.symbol, intent: args.intent, provider: args.provider });
  const { error } = await svc.from("evidence_cache_v2").upsert({
    market: "india",
    symbol: args.symbol,
    intent: args.intent,
    provider_id: args.provider,
    request_fingerprint: requestFingerprint,
    schema_version: CONTRACT,
    payload: args.payload,
    quality_state: args.quality,
    observed_at: args.observedAt ?? now.toISOString(),
    fetched_at: now.toISOString(),
    expires_at: new Date(now.getTime() + 24 * 3600_000).toISOString(),
    stale_until: new Date(now.getTime() + 7 * 86400_000).toISOString(),
    currency: "INR",
    basis: "spot",
    payload_hash: hash(args.payload),
    provenance: [{
      providerId: args.provider,
      providerField: args.intent,
      basis: "spot",
      observedAt: args.observedAt ?? now.toISOString(),
      retrievedAt: now.toISOString(),
      currency: "INR",
      unit: "text",
    }],
  }, { onConflict: "market,symbol,intent,provider_id,request_fingerprint" });
  if (error) throw new Error(`evidence cache write failed: ${error.message}`);
}

export async function GET(req: NextRequest) {
  const cron = verifyCronSecret(req);
  if (!cron) {
    const gate = await requireOwner();
    if (gate) return gate;
  }
  const svc = createServiceClient();
  const runId = `india-news-shadow:${new Date().toISOString()}`;
  const nowIso = new Date().toISOString();

  const [paperRes, watchRes, profileRes, priorRes] = await Promise.all([
    svc.from("paper_positions").select("symbol,qty").eq("market", "india").gt("qty", 0),
    svc.from("watchlist").select("symbol,company_name,research_enabled,expires_at").eq("market", "india")
      .or(`expires_at.is.null,expires_at.gt.${nowIso}`),
    svc.from("symbol_profiles").select("symbol,company_name").eq("market", "india"),
    svc.from("evidence_cache_v2").select("symbol,fetched_at").eq("market", "india").eq("intent", RSS_INTENT),
  ]);
  if (paperRes.error || watchRes.error || profileRes.error || priorRes.error) {
    return NextResponse.json({ error: "India news shadow universe read failed" }, { status: 500 });
  }

  const names = new Map<string, string>();
  for (const row of [...(profileRes.data ?? []), ...(watchRes.data ?? [])] as any[]) {
    const symbol = String(row.symbol ?? "").toUpperCase();
    if (symbol && row.company_name) names.set(symbol, String(row.company_name));
  }
  const held = new Set<string>((paperRes.data ?? []).map((row: any) => String(row.symbol).toUpperCase()));
  const candidates = new Set<string>(held);
  for (const row of watchRes.data ?? []) if ((row as any).research_enabled !== false) candidates.add(String((row as any).symbol).toUpperCase());
  const lastFetched = new Map((priorRes.data ?? []).map((row: any) => [String(row.symbol).toUpperCase(), String(row.fetched_at ?? "")]));
  const symbols = [...candidates]
    .filter((symbol) => /\.(NS|BO)$/i.test(symbol))
    .sort((a, b) => Number(held.has(b)) - Number(held.has(a)) || String(lastFetched.get(a) ?? "").localeCompare(String(lastFetched.get(b) ?? "")) || a.localeCompare(b))
    .slice(0, MAX_SYMBOLS);

  const runInsert = await svc.from("agent_runs").insert({
    agent_type: "india_news_shadow", status: "running", market: "india", symbols,
    trigger_source: cron ? "scheduled" : "manual",
  }).select("id").maybeSingle();
  const agentRunId = runInsert.data?.id ?? null;

  const nseStart = Date.now();
  const announcements = await fetchNseCorporateAnnouncements().catch(() => []);
  await ledger(svc, {
    provider: NSE_PROVIDER, intent: NSE_INTENT, market: "india", symbol: "__MARKET__", run_id: runId,
    cache_outcome: "miss", lease_outcome: announcements.length ? "completed" : "denied", started_at: new Date(nseStart).toISOString(),
    completed_at: new Date().toISOString(), latency_ms: Date.now() - nseStart,
    transport_status: announcements.length ? "200" : "unavailable_or_empty",
    error_code: announcements.length ? null : "provider_error", response_bytes: null, contract_version: CONTRACT,
  });
  const announcementsBySymbol = new Map<string, CorporateAnnouncement[]>();
  for (const item of announcements) {
    if (!announcementsBySymbol.has(item.symbol)) announcementsBySymbol.set(item.symbol, []);
    announcementsBySymbol.get(item.symbol)!.push(item);
  }
  for (const symbol of symbols) {
    const events = (announcementsBySymbol.get(symbol) ?? []).slice(0, 20);
    await cacheEvidence(svc, { symbol, intent: NSE_INTENT, provider: NSE_PROVIDER, payload: { events }, quality: events.length ? "fresh" : "partial" });
  }

  let rssAvailable = 0;
  let rssErrors = 0;
  for (let i = 0; i < symbols.length; i += 3) {
    await Promise.all(symbols.slice(i, i + 3).map(async (symbol) => {
      const companyName = names.get(symbol) ?? symbol.replace(/\.(NS|BO)$/i, "");
      const started = Date.now();
      const result = await fetchGoogleNewsHeadlines(symbol, companyName);
      await ledger(svc, {
        provider: RSS_PROVIDER, intent: RSS_INTENT, market: "india", symbol, run_id: runId,
        cache_outcome: "miss", lease_outcome: result.ok ? "completed" : "denied",
        started_at: new Date(started).toISOString(), completed_at: new Date().toISOString(), latency_ms: Date.now() - started,
        transport_status: result.status == null ? null : String(result.status), error_code: result.errorCode,
        response_bytes: result.responseBytes, contract_version: CONTRACT,
      });
      if (!result.ok) { rssErrors++; return; }
      if (result.headlines.length) rssAvailable++;
      await cacheEvidence(svc, {
        symbol, intent: RSS_INTENT, provider: RSS_PROVIDER,
        payload: { query: result.query.slice(0, 180), headlines: result.headlines },
        observedAt: result.headlines[0]?.publishedAt ?? null,
        quality: result.headlines.length ? "fresh" : "partial",
      });
    }));
  }

  if (agentRunId) await svc.from("agent_runs").update({
    status: "done", signals_written: 0,
    result_summary: `Shadow only: ${symbols.length} symbols, RSS available ${rssAvailable}, RSS errors ${rssErrors}, NSE announcements ${announcements.length}; behavior changed=false`,
    completed_at: new Date().toISOString(), tokens_input: 0, tokens_output: 0, claude_calls: 0,
  }).eq("id", agentRunId);

  return NextResponse.json({
    ok: true, market: "india", shadowOnly: true, behaviorChanged: false,
    symbolsProcessed: symbols.length, rssAvailable, rssErrors, nseAnnouncements: announcements.length,
  });
}

export const POST = GET;
