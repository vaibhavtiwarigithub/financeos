import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/service";
import { ALGO_STRATEGIES, STRATEGY_MAP } from "@/lib/strategy-definitions";
import { avCachedFetch } from "@/lib/av-cache";
import { providerCachedFetch } from "@/lib/data/provider-fetch";
import { verifyCronSecret } from "@/lib/auth/cron";
import { requireOwner } from "@/lib/auth/require-owner";
import { reportIssue, resolveIssue } from "@/lib/system-health";
import {
  classifyFinancialDatasetsFailure,
  financialDatasetsFailureDetail,
  type FinancialDatasetsFailure,
} from "@/lib/data/financialdatasets-status";
import {
  FINANCIAL_DATASETS_SCREENER_URL,
  financialDatasetsScreenerRows,
  normalizeFinancialDatasetsScreenerFilters,
} from "@/lib/data/financialdatasets-screener";

export const dynamic = "force-dynamic";

// GET Alpha Vantage key from vault or env
async function getAVKey(supabase: any): Promise<string> {
  try {
    const { data } = await supabase.from("api_key_vault").select("key_value").eq("key_name", "ALPHA_VANTAGE_API_KEY").single();
    return (data as any)?.key_value ?? process.env.ALPHA_VANTAGE_API_KEY ?? "";
  } catch { return process.env.ALPHA_VANTAGE_API_KEY ?? ""; }
}

// GET FinancialDatasets key from vault or env
async function getFDKey(supabase: any): Promise<string> {
  try {
    const { data } = await supabase.from("api_key_vault").select("key_value").eq("key_name", "FINANCIAL_DATASETS_API_KEY").single();
    return (data as any)?.key_value ?? process.env.FINANCIAL_DATASETS_API_KEY ?? "";
  } catch { return process.env.FINANCIAL_DATASETS_API_KEY ?? ""; }
}

// Screen via FinancialDatasets REST API
async function screenFundamentals(
  filters: Array<{ field: string; operator: string; value: number }>,
  fdKey: string,
  limit = 20
): Promise<{ symbols: string[]; failure: FinancialDatasetsFailure | null }> {
  if (!fdKey) return { symbols: [], failure: { code: "unauthorized" } };
  try {
    const res = await fetch(FINANCIAL_DATASETS_SCREENER_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-API-KEY": fdKey },
      body: JSON.stringify({ filters, limit }),
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) {
      const responseBody = await res.text().catch(() => "");
      return { symbols: [], failure: classifyFinancialDatasetsFailure(res.status, responseBody) };
    }
    const data = await res.json();
    // FinancialDatasets returns { results: [{ticker, ...}] } or similar
    const results = financialDatasetsScreenerRows(data);
    return {
      symbols: results
        .map((r: any) => (r.ticker ?? r.symbol ?? "").toUpperCase())
        .filter(Boolean)
        .slice(0, limit),
      failure: null,
    };
  } catch { return { symbols: [], failure: { code: "network_error" } }; }
}

// Fetch RSI-14 daily for a symbol from Alpha Vantage (day-cached — AV is 25/day).
async function fetchRSI(symbol: string, avKey: string): Promise<number | null> {
  if (!avKey) return null;
  const url = `https://www.alphavantage.co/query?function=RSI&symbol=${symbol}&interval=daily&time_period=14&series_type=close&apikey=${avKey}`;
  const json = await avCachedFetch(`RSI:${symbol}`, url, 5000);
  const series = json?.["Technical Analysis: RSI"];
  if (!series) return null;
  const latest = Object.values(series)[0] as any;
  return parseFloat(latest?.RSI ?? "0") || null;
}

// Fetch latest price and EMA50 from Alpha Vantage (both day-cached).
async function fetchTechnicals(symbol: string, avKey: string): Promise<{ price: number | null; ema50: number | null }> {
  if (!avKey) return { price: null, ema50: null };
  const [quoteJson, emaJson] = await Promise.all([
    avCachedFetch(`QUOTE:${symbol}`, `https://www.alphavantage.co/query?function=GLOBAL_QUOTE&symbol=${symbol}&apikey=${avKey}`, 5000),
    avCachedFetch(`EMA50:${symbol}`, `https://www.alphavantage.co/query?function=EMA&symbol=${symbol}&interval=daily&time_period=50&series_type=close&apikey=${avKey}`, 5000),
  ]);
  const price = parseFloat(quoteJson?.["Global Quote"]?.["05. price"] ?? "0") || null;
  const emaSeries = emaJson?.["Technical Analysis: EMA"];
  const ema50 = emaSeries ? parseFloat((Object.values(emaSeries)[0] as any)?.EMA ?? "0") || null : null;
  return { price, ema50 };
}

// Fetch basic fundamentals from FinancialDatasets for a specific symbol.
// Day-cached — FinancialDatasets' free tier is limited too, and this was
// called uncached once per scanned symbol on every request.
async function fetchFundamentals(symbol: string, fdKey: string): Promise<Record<string, any>> {
  if (!fdKey) return {};
  try {
    const url = `https://api.financialdatasets.ai/financial-metrics/snapshot/?ticker=${symbol}`;
    // FinancialDatasets has its OWN daily budget now — routing this through the
    // FD provider instead of avCachedFetch stops it from consuming an Alpha
    // Vantage 25/day slot (the shared-budget bug).
    const data = await providerCachedFetch("financialdatasets", `FD_SNAPSHOT:${symbol}`, url, { timeoutMs: 8000, headers: { "X-API-KEY": fdKey } });
    return data?.snapshot ?? data?.metrics ?? data ?? {};
  } catch { return {}; }
}

export interface ScanResult {
  symbol: string;
  rsi: number | null;
  price: number | null;
  ema50: number | null;
  price_above_ma50: boolean | null;
  fundamental_score: number | null;
  technical_score: number | null;
  combined_score: number | null;
  fundamentals: Record<string, any>;
  passes_filters: boolean;
  data_sufficient: boolean;
  filter_notes: string[];
}

export async function POST(req: NextRequest) {
  // Cron-or-owner: this burns Alpha Vantage / FinancialDatasets budget, so it
  // must never be anonymous. Accept the cron secret OR an owner session.
  if (!verifyCronSecret(req)) {
    const gate = await requireOwner();
    if (gate) return gate;
  }
  try {
    const body = await req.json().catch(() => ({}));
    const {
      strategy_id,
      custom_filters = [],
      rsi_min,
      rsi_max,
      price_above_ma50,
      symbols: manualSymbols,
      limit = 15,
    } = body as {
      strategy_id?: string;
      custom_filters?: Array<{ field: string; operator: string; value: number }>;
      rsi_min?: number;
      rsi_max?: number;
      price_above_ma50?: boolean;
      symbols?: string[];
      limit?: number;
    };

    const supabase = createServiceClient();
    const [avKey, fdKey] = await Promise.all([getAVKey(supabase), getFDKey(supabase)]);

    // Resolve strategy
    const strategy = strategy_id ? STRATEGY_MAP[strategy_id] : null;
    const scanFilters = strategy ? strategy.scan_filters : custom_filters;
    const techConditions = strategy?.conditions?.technical ?? {};

    const effectiveRsiMin  = rsi_min  ?? techConditions.rsi_min;
    const effectiveRsiMax  = rsi_max  ?? techConditions.rsi_max;
    const effectiveMa50    = price_above_ma50 ?? techConditions.price_above_ma50;

    // Get candidate symbols
    let candidates: string[] = manualSymbols ?? [];

    let fdFailure: FinancialDatasetsFailure | null = null;
    let fdScreenProbed = false;
    if (!candidates.length && fdKey && scanFilters.length) {
      fdScreenProbed = true;
      const screenResult = await screenFundamentals(
        normalizeFinancialDatasetsScreenerFilters(scanFilters),
        fdKey,
        Math.min(limit * 2, 40),
      );
      candidates = screenResult.symbols;
      fdFailure = screenResult.failure;
    }

    const fdIssueKey = "provider-unavailable:financialdatasets";
    if (fdFailure) {
      await reportIssue({
        issueKey: fdIssueKey,
        severity: "warn",
        category: "data_provider",
        title: "FinancialDatasets screener unavailable - US discovery using other queues",
        detail: `${financialDatasetsFailureDetail(fdFailure)} The manual Scanner and ResearchAgent fall back without treating missing provider data as a passing fundamental result.`,
      }, supabase);
    } else if (fdScreenProbed) {
      await resolveIssue(fdIssueKey, supabase);
    }

    // Fallback: use recent watchlist + signals
    if (!candidates.length) {
      const [wlRes, sigRes] = await Promise.all([
        supabase.from("watchlist").select("symbol").eq("market", "us").limit(20),
        supabase.from("agent_signals").select("symbol").eq("market", "us").eq("direction", "long").order("created_at", { ascending: false }).limit(20),
      ]);
      const wl: string[] = (wlRes.data ?? []).map((r: any) => r.symbol);
      const sig: string[] = (sigRes.data ?? []).map((r: any) => r.symbol);
      candidates = [...new Set([...wl, ...sig])].slice(0, limit * 2);
    }

    candidates = [...new Set(candidates)].slice(0, 30);

    // Enrich each candidate with technicals (rate-limit: batch with delays)
    const results: ScanResult[] = [];
    const batchSize = 5;

    for (let i = 0; i < candidates.length; i += batchSize) {
      const batch = candidates.slice(i, i + batchSize);
      const batchResults = await Promise.all(batch.map(async symbol => {
        const [rsi, { price, ema50 }, fundamentals] = await Promise.all([
          fetchRSI(symbol, avKey),
          fetchTechnicals(symbol, avKey),
          fdKey ? fetchFundamentals(symbol, fdKey) : Promise.resolve({}),
        ]);

        const priceAboveMa50 = price != null && ema50 != null ? price > ema50 : null;
        const hasFundData = Object.keys(fundamentals as object).length > 0;

        // Technical score — null (not a fabricated 50) when there's no RSI to score
        let techScore: number | null = null;
        const filterNotes: string[] = [];
        let passes = true;
        let notEvaluated = false;

        if (rsi != null) {
          if (rsi > 60)      techScore = 75;
          else if (rsi < 40) techScore = 35;
          else               techScore = 50 + (rsi - 50) * 0.5;

          if (effectiveRsiMin != null && rsi < effectiveRsiMin) {
            filterNotes.push(`RSI ${rsi.toFixed(0)} < required ${effectiveRsiMin}`);
            passes = false;
          }
          if (effectiveRsiMax != null && rsi > effectiveRsiMax) {
            filterNotes.push(`RSI ${rsi.toFixed(0)} > max ${effectiveRsiMax}`);
            passes = false;
          }
        } else if (effectiveRsiMin != null || effectiveRsiMax != null) {
          // An RSI filter is active but we have no RSI to check it against —
          // this used to silently "pass" (the condition just never ran).
          filterNotes.push("RSI unavailable — condition not evaluated");
          notEvaluated = true;
        }

        if (effectiveMa50 === true && priceAboveMa50 === false) {
          filterNotes.push("Price below 50-day MA");
          passes = false;
        } else if (effectiveMa50 === false && priceAboveMa50 === true) {
          filterNotes.push("Price above 50-day MA (need below)");
          passes = false;
        } else if (effectiveMa50 != null && priceAboveMa50 === null) {
          filterNotes.push("Price/MA50 unavailable — condition not evaluated");
          notEvaluated = true;
        }

        // Fundamental score from FD snapshot — null (not a fabricated 50/40)
        // when there's no real fundamentals data (no FD key or empty result).
        let fundScore: number | null = null;
        if (hasFundData) {
          const f    = fundamentals as any;
          const pe   = parseFloat(f.pe_ratio ?? f.price_to_earnings_ratio ?? "0");
          const roe  = parseFloat(f.return_on_equity ?? "0");
          const revG = parseFloat(f.revenue_growth ?? "0");
          const fcf  = parseFloat(f.free_cash_flow_yield ?? "0");

          let pts = 0;
          if (pe > 0 && pe < 20)   pts += 20;
          else if (pe < 30)         pts += 10;
          if (roe > 0.20)           pts += 25;
          else if (roe > 0.12)      pts += 15;
          if (revG > 0.20)          pts += 25;
          else if (revG > 0.08)     pts += 15;
          if (fcf > 0.05)           pts += 15;
          else if (fcf > 0.02)      pts += 8;
          fundScore = Math.min(95, 40 + pts);
        }

        const combined = techScore != null && fundScore != null
          ? Math.round(fundScore * 0.5 + techScore * 0.5)
          : techScore != null ? Math.round(techScore)
          : fundScore != null ? Math.round(fundScore)
          : null;

        // A verdict is only meaningful if we actually had data to evaluate it
        // against — missing data used to silently skip every falsifying
        // check, which read as "all conditions met" with nothing checked.
        const dataSufficient = !notEvaluated;
        const passesFilters = passes && dataSufficient;
        if (passesFilters && filterNotes.length === 0) filterNotes.push("All conditions met");
        if (!dataSufficient && filterNotes.length === 0) filterNotes.push("Insufficient data to evaluate conditions");

        return {
          symbol,
          rsi: rsi != null ? parseFloat(rsi.toFixed(1)) : null,
          price,
          ema50,
          price_above_ma50: priceAboveMa50,
          fundamental_score: fundScore != null ? Math.round(fundScore) : null,
          technical_score: techScore != null ? Math.round(techScore) : null,
          combined_score: combined,
          fundamentals,
          passes_filters: passesFilters,
          data_sufficient: dataSufficient,
          filter_notes: filterNotes,
        } as ScanResult;
      }));
      results.push(...batchResults);

      // Small delay between batches to avoid AV rate limit (5 calls/min free tier)
      if (i + batchSize < candidates.length) {
        await new Promise(r => setTimeout(r, 1200));
      }
    }

    // Sort: passing first, then by combined score
    results.sort((a, b) => {
      if (a.passes_filters && !b.passes_filters) return -1;
      if (!a.passes_filters && b.passes_filters) return 1;
      return (b.combined_score ?? -1) - (a.combined_score ?? -1);
    });

    return NextResponse.json({
      strategy: strategy ? { id: strategy.id, name: strategy.name } : null,
      total_scanned: candidates.length,
      passing: results.filter(r => r.passes_filters).length,
      results: results.slice(0, limit),
      data_sources: {
        fundamentals: !fdKey
          ? "unavailable (no FD key)"
          : fdFailure
            ? `unavailable (${fdFailure.code})`
            : fdScreenProbed
              ? "FinancialDatasets (available)"
              : "FinancialDatasets (configured; fail-soft per symbol)",
        technicals:   avKey ? "Alpha Vantage"     : "unavailable (no AV key)",
      },
    });
  } catch (err: unknown) {
    return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 500 });
  }
}

// GET: list available strategies for scanner dropdown
export async function GET() {
  return NextResponse.json({
    strategies: ALGO_STRATEGIES.map(s => ({
      id: s.id, name: s.name, icon: s.icon, tagline: s.tagline, regimes: s.regimes,
    })),
  });
}
