import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/service";
import { ALGO_STRATEGIES, STRATEGY_MAP } from "@/lib/strategy-definitions";

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
): Promise<string[]> {
  if (!fdKey) return [];
  try {
    const res = await fetch("https://api.financialdatasets.ai/stocks/screener/", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-API-KEY": fdKey },
      body: JSON.stringify({ filters, limit }),
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) return [];
    const data = await res.json();
    // FinancialDatasets returns { results: [{ticker, ...}] } or similar
    const results: any[] = data?.results ?? data?.data ?? data?.stocks ?? [];
    return results
      .map((r: any) => (r.ticker ?? r.symbol ?? "").toUpperCase())
      .filter(Boolean)
      .slice(0, limit);
  } catch { return []; }
}

// Fetch RSI-14 daily for a symbol from Alpha Vantage
async function fetchRSI(symbol: string, avKey: string): Promise<number | null> {
  if (!avKey) return null;
  try {
    const url = `https://www.alphavantage.co/query?function=RSI&symbol=${symbol}&interval=daily&time_period=14&series_type=close&apikey=${avKey}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) return null;
    const json = await res.json();
    const series = json?.["Technical Analysis: RSI"];
    if (!series) return null;
    const latest = Object.values(series)[0] as any;
    return parseFloat(latest?.RSI ?? "0") || null;
  } catch { return null; }
}

// Fetch latest price and EMA50 from Alpha Vantage
async function fetchTechnicals(symbol: string, avKey: string): Promise<{ price: number | null; ema50: number | null }> {
  if (!avKey) return { price: null, ema50: null };
  try {
    const [quoteRes, emaRes] = await Promise.all([
      fetch(`https://www.alphavantage.co/query?function=GLOBAL_QUOTE&symbol=${symbol}&apikey=${avKey}`, { signal: AbortSignal.timeout(5000) }),
      fetch(`https://www.alphavantage.co/query?function=EMA&symbol=${symbol}&interval=daily&time_period=50&series_type=close&apikey=${avKey}`, { signal: AbortSignal.timeout(5000) }),
    ]);
    const quoteJson = quoteRes.ok ? await quoteRes.json() : {};
    const emaJson   = emaRes.ok   ? await emaRes.json()   : {};

    const price = parseFloat(quoteJson?.["Global Quote"]?.["05. price"] ?? "0") || null;
    const emaSeries = emaJson?.["Technical Analysis: EMA"];
    const ema50 = emaSeries ? parseFloat((Object.values(emaSeries)[0] as any)?.EMA ?? "0") || null : null;
    return { price, ema50 };
  } catch { return { price: null, ema50: null }; }
}

// Fetch basic fundamentals from FinancialDatasets for a specific symbol
async function fetchFundamentals(symbol: string, fdKey: string): Promise<Record<string, any>> {
  if (!fdKey) return {};
  try {
    const res = await fetch(
      `https://api.financialdatasets.ai/financial-metrics/snapshot/?ticker=${symbol}`,
      { headers: { "X-API-KEY": fdKey }, signal: AbortSignal.timeout(8000) }
    );
    if (!res.ok) return {};
    const data = await res.json();
    return data?.snapshot ?? data?.metrics ?? data ?? {};
  } catch { return {}; }
}

export interface ScanResult {
  symbol: string;
  rsi: number | null;
  price: number | null;
  ema50: number | null;
  price_above_ma50: boolean | null;
  fundamental_score: number;
  technical_score: number;
  combined_score: number;
  fundamentals: Record<string, any>;
  passes_filters: boolean;
  filter_notes: string[];
}

export async function POST(req: NextRequest) {
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

    if (!candidates.length && fdKey && scanFilters.length) {
      candidates = await screenFundamentals(scanFilters, fdKey, Math.min(limit * 2, 40));
    }

    // Fallback: use recent watchlist + signals
    if (!candidates.length) {
      const [wlRes, sigRes] = await Promise.all([
        supabase.from("watchlist").select("symbol").limit(20),
        supabase.from("agent_signals").select("symbol").eq("direction", "long").order("created_at", { ascending: false }).limit(20),
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

        // Technical score
        let techScore = 50;
        const filterNotes: string[] = [];
        let passes = true;

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
        }

        if (effectiveMa50 === true && priceAboveMa50 === false) {
          filterNotes.push("Price below 50-day MA");
          passes = false;
        }
        if (effectiveMa50 === false && priceAboveMa50 === true) {
          filterNotes.push("Price above 50-day MA (need below)");
          passes = false;
        }

        // Fundamental score from FD snapshot
        let fundScore = 50;
        if (fundamentals) {
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

        const combined = Math.round(fundScore * 0.5 + techScore * 0.5);

        if (passes && filterNotes.length === 0) filterNotes.push("All conditions met");

        return {
          symbol,
          rsi: rsi != null ? parseFloat(rsi.toFixed(1)) : null,
          price,
          ema50,
          price_above_ma50: priceAboveMa50,
          fundamental_score: Math.round(fundScore),
          technical_score: Math.round(techScore),
          combined_score: combined,
          fundamentals,
          passes_filters: passes,
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
      return b.combined_score - a.combined_score;
    });

    return NextResponse.json({
      strategy: strategy ? { id: strategy.id, name: strategy.name } : null,
      total_scanned: candidates.length,
      passing: results.filter(r => r.passes_filters).length,
      results: results.slice(0, limit),
      data_sources: {
        fundamentals: fdKey ? "FinancialDatasets" : "unavailable (no FD key)",
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
