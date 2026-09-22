// Global-spillover shadow, Phase 0 (measure-only). Owner-approved 2026-09-22:
// "let's do the Tokyo one" — record foreign-index and US-futures session
// changes into the existing, previously-empty exogenous_observations table
// (migration exogenous_risk_p0, 2026-08-01) so a real IC/counterfactual study
// can later ask whether any of this predicts US or India forward returns, at
// what lag, before any score/sizing/order path is allowed to read it.
//
// NOT A SIGNAL. This route writes ONLY to exogenous_observations. No score,
// gate, sizing, exit, or order path reads that table (see its own comment).
// Phase 1 (evidence review) and Phase 2 (any wiring into a real decision) are
// separate, later, explicitly-approved steps — see the architecture note in
// this conversation for the full phased plan and why it must stay measure-
// only until proven.
import { createHash } from "crypto";
import { NextRequest, NextResponse } from "next/server";
import { verifyCronSecret } from "@/lib/auth/cron";
import { createServiceClient } from "@/lib/supabase/service";
import { fetchYahooCandles } from "@/lib/data/yahoo-candles";
import { latestSessionChangePct } from "@/lib/trading/global-spillover-features";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

// Curated, deliberately small starting universe. Each entry: the Yahoo ticker,
// a series_key slug, and a human label for the rationale text. Index futures
// (ES=F/NQ=F) are included specifically to test the "already arbed into
// futures before the cash open" hypothesis discussed in the architecture
// review — if spillover shows up in futures but NOT beyond what futures
// already carry, that's evidence there's nothing left for a cash-market
// research process to capture.
const SERIES: Array<{ symbol: string; seriesKey: string; label: string }> = [
  { symbol: "^N225", seriesKey: "nikkei225.session_change_pct", label: "Nikkei 225 (Tokyo)" },
  { symbol: "^HSI", seriesKey: "hangseng.session_change_pct", label: "Hang Seng (Hong Kong)" },
  { symbol: "000001.SS", seriesKey: "sse_composite.session_change_pct", label: "Shanghai Composite" },
  { symbol: "^GDAXI", seriesKey: "dax.session_change_pct", label: "DAX (Frankfurt)" },
  { symbol: "^FTSE", seriesKey: "ftse100.session_change_pct", label: "FTSE 100 (London)" },
  { symbol: "ES=F", seriesKey: "es_futures.session_change_pct", label: "S&P 500 futures (near-24h)" },
  { symbol: "NQ=F", seriesKey: "nq_futures.session_change_pct", label: "Nasdaq-100 futures (near-24h)" },
];

function fingerprint(payload: unknown): string {
  return createHash("sha256").update(JSON.stringify(payload)).digest("hex");
}

export async function GET(req: NextRequest) {
  if (!verifyCronSecret(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const supabase = createServiceClient();
  const now = new Date();

  const results: Array<{ seriesKey: string; status: string; changePct?: number; error?: string }> = [];
  for (const s of SERIES) {
    try {
      const candles = await fetchYahooCandles(s.symbol, "5d");
      const change = latestSessionChangePct(candles);
      if (!change) {
        results.push({ seriesKey: s.seriesKey, status: "unavailable" });
        continue;
      }
      const payload = { symbol: s.symbol, ...change };
      const row = {
        market: "global", scope: "global_spillover", series_key: s.seriesKey,
        value: change.changePct, unit: "pct", observed_period: change.sessionDate,
        // Exact per-exchange close timestamps vary (Tokyo ~06:00 UTC, DAX/FTSE
        // ~15:30-16:30 UTC, futures near-continuous) and this collector does not
        // know them precisely. Claiming a fabricated close time as published_at
        // would be a false, possibly-too-early provenance claim — exactly what
        // this table exists to prevent. Both timestamps are honestly the same
        // instant: when this collector actually observed the value. The session
        // it refers to is carried separately in observed_period.
        published_at: now.toISOString(),
        available_at: now.toISOString(),
        source: "yahoo", source_url: `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(s.symbol)}`,
        source_revision: null,
        payload_fingerprint: fingerprint(payload),
        quality: "fresh",
      };
      const { error } = await supabase.from("exogenous_observations").insert(row);
      if (error?.code === "23505") { results.push({ seriesKey: s.seriesKey, status: "already_recorded" }); continue; }
      if (error) throw new Error(error.message);
      results.push({ seriesKey: s.seriesKey, status: "recorded", changePct: change.changePct });
    } catch (err: any) {
      const message = err?.message ?? String(err);
      console.error(`[global-spillover-collect] ${s.seriesKey}: ${message}`);
      results.push({ seriesKey: s.seriesKey, status: "error", error: message });
    }
  }

  return NextResponse.json({ status: "ran", now: now.toISOString(), results });
}
