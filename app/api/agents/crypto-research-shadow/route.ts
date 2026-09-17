import { createHash } from "crypto";
import { NextRequest, NextResponse } from "next/server";
import { requireOwner } from "@/lib/auth/require-owner";
import { verifyCronSecret } from "@/lib/auth/cron";
import { createServiceClient } from "@/lib/supabase/service";
import { CRYPTO_SYMBOLS } from "@/lib/scoring/instrument-taxonomy";
import { scoreCryptoShadow } from "@/lib/scoring/crypto-score";
import { deriveCryptoResearchShadow } from "@/lib/scoring/crypto-research-shadow";
import { fetchCryptoCandles } from "@/lib/data/crypto-quotes";
import { cryptoCompletedCandles, cryptoSessionDate } from "@/lib/data/crypto-session";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const STRATEGY_VERSION = "crypto-native-daily-shadow-v1";

/**
 * A dedicated 24/7 lane for native crypto evidence. It deliberately does not
 * read or write equity agent_signals: an AV daily close is research evidence,
 * not an executable broker quote. Every unavailable input becomes a persisted
 * refusal so a quiet page can never masquerade as a healthy trade decision.
 */
export async function POST(req: NextRequest) {
  if (!verifyCronSecret(req)) {
    const gate = await requireOwner();
    if (gate) return gate;
  }
  const supabase = createServiceClient();
  const { data: vaultKey } = await supabase.from("api_key_vault")
    .select("key_value").eq("key_name", "ALPHA_VANTAGE_API_KEY").maybeSingle();
  const avKey = (vaultKey as any)?.key_value ?? process.env.ALPHA_VANTAGE_API_KEY ?? null;
  const expectedSession = cryptoSessionDate();
  const rows: any[] = [];
  const shadows: any[] = [];

  for (const symbol of [...CRYPTO_SYMBOLS]) {
    const { candles, source } = avKey ? await fetchCryptoCandles(symbol, avKey) : { candles: [], source: "unavailable" };
    const completed = cryptoCompletedCandles(candles);
    const last = completed.at(-1);
    const evidence = last?.date === expectedSession ? deriveCryptoResearchShadow(completed) : null;
    const baseReason = !avKey ? "alpha_vantage_key_unavailable"
      : !last || last.date !== expectedSession ? "daily_candle_unavailable_or_stale"
      : !evidence ? "insufficient_or_invalid_daily_history"
      : "broker_pair_and_executable_quote_not_observed";
    rows.push({
      symbol,
      broker_tradeable: false,
      account_eligible: false,
      history_days: completed.length,
      quote_observed_at: null,
      bid: null,
      ask: null,
      spread_pct: null,
      admitted: false,
      refusal_reason: baseReason,
      raw: { source, expected_session: expectedSession, observed_session: last?.date ?? null, evidence },
    });
    const score = evidence ? scoreCryptoShadow({
      trendScore: evidence.trendScore,
      structureScore: evidence.structureScore,
      volatilityScore: evidence.volatilityScore,
      spreadPct: null,
      quoteAgeSeconds: null,
      maxSpreadPct: 0.5,
      maxQuoteAgeSeconds: 15,
    }) : null;
    const refusalReason = score && !score.ok ? score.reason : baseReason;
    const fingerprint = createHash("sha256")
      .update(JSON.stringify({ symbol, strategy: STRATEGY_VERSION, expectedSession, close: evidence?.close ?? null, source, refusalReason }))
      .digest("hex");
    shadows.push({
      symbol,
      strategy_version: STRATEGY_VERSION,
      entry_price: evidence?.close ?? null,
      quote_observed_at: null,
      spread_pct: null,
      geometry: { source, expected_session: expectedSession, evidence, score: score ?? { ok: false, reason: baseReason }, execution_gate: "no_broker_quote_or_pair_observation" },
      decision: "refused",
      refusal_reason: refusalReason,
      input_fingerprint: fingerprint,
    });
  }

  const fresh = rows.filter((row) => row.raw.observed_session === expectedSession).length;
  const { data: run, error: runError } = await supabase.from("crypto_universe_runs").insert({
    source: "alpha_vantage_daily_crypto_shadow",
    status: fresh === rows.length ? "partial" : "error",
    summary: { lane: "crypto_native_shadow", expected_session: expectedSession, symbols: rows.length, fresh_daily_evidence: fresh, executable_quotes: 0, admitted: 0, live_execution_enabled: false },
    error: fresh === rows.length ? "broker pair and executable quote collection is not implemented" : "one or more required daily candles were unavailable or stale",
  }).select("id").single();
  if (runError || !run) return NextResponse.json({ error: "crypto universe run write failed" }, { status: 500 });
  const { error: memberError } = await supabase.from("crypto_universe_members").insert(rows.map((row) => ({ ...row, run_id: run.id })));
  if (memberError) return NextResponse.json({ error: "crypto universe member write failed" }, { status: 500 });
  const { error: shadowError } = await supabase.from("crypto_geometry_shadows").upsert(shadows, { onConflict: "symbol,strategy_version,input_fingerprint", ignoreDuplicates: true });
  if (shadowError) return NextResponse.json({ error: "crypto shadow write failed" }, { status: 500 });
  return NextResponse.json({ success: true, run_id: run.id, expected_session: expectedSession, fresh_daily_evidence: fresh, admitted: 0, refusals: rows.map((row) => ({ symbol: row.symbol, reason: row.refusal_reason })) });
}

export async function GET(req: NextRequest) { return POST(req); }
