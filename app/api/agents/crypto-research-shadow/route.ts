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
import { readRobinhoodCryptoExecutionSnapshot } from "@/lib/robinhood-mcp";

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
  // Broker information is execution evidence. It is intentionally collected
  // separately from public historical candles and cannot turn a shadow into an
  // executable candidate while Robinhood lacks a verified pair-inventory API.
  const broker = await readRobinhoodCryptoExecutionSnapshot([...CRYPTO_SYMBOLS]);
  const candleResults = await Promise.all([...CRYPTO_SYMBOLS].map((symbol) => fetchCryptoCandles(symbol, avKey ?? "")));
  const rows: any[] = [];
  const shadows: any[] = [];

  for (const [index, symbol] of [...CRYPTO_SYMBOLS].entries()) {
    const { candles, source, attempted } = candleResults[index];
    const completed = cryptoCompletedCandles(candles);
    const last = completed.at(-1);
    const evidence = last?.date === expectedSession ? deriveCryptoResearchShadow(completed) : null;
    const quote = broker.quotes.get(symbol);
    const spreadPct = quote ? ((quote.ask - quote.bid) / quote.ask) * 100 : null;
    const baseReason = !last || last.date !== expectedSession ? "daily_candle_unavailable_or_stale"
      : !evidence ? "insufficient_or_invalid_daily_history"
      : !broker.connected ? "robinhood_mcp_not_connected"
      : !broker.accountEligible ? "broker_account_eligibility_not_observed"
      : !quote ? "broker_executable_quote_not_observed"
      : !broker.pairInventoryObserved ? "broker_pair_inventory_not_observed"
      : "broker_pair_and_executable_quote_not_observed";
    rows.push({
      symbol,
      broker_tradeable: false,
      account_eligible: broker.accountEligible,
      history_days: completed.length,
      quote_observed_at: quote?.observedAt ?? null,
      bid: quote?.bid ?? null,
      ask: quote?.ask ?? null,
      spread_pct: spreadPct,
      admitted: false,
      refusal_reason: baseReason,
      raw: {
        candle_source: source, candle_sources_attempted: attempted,
        expected_session: expectedSession, observed_session: last?.date ?? null, evidence,
        broker: { connected: broker.connected, account_eligible: broker.accountEligible, pair_inventory_observed: broker.pairInventoryObserved, quote_tool_available: broker.quoteToolAvailable, error_codes: broker.errorCodes },
      },
    });
    const score = evidence ? scoreCryptoShadow({
      trendScore: evidence.trendScore,
      structureScore: evidence.structureScore,
      volatilityScore: evidence.volatilityScore,
      spreadPct,
      quoteAgeSeconds: quote ? 0 : null,
      maxSpreadPct: 0.5,
      maxQuoteAgeSeconds: 15,
    }) : null;
    const refusalReason = score && !score.ok ? score.reason : baseReason;
    const fingerprint = createHash("sha256")
      .update(JSON.stringify({ symbol, strategy: STRATEGY_VERSION, expectedSession, close: evidence?.close ?? null, source, attempted, quote: quote ? { bid: quote.bid, ask: quote.ask, observedAt: quote.observedAt } : null, refusalReason }))
      .digest("hex");
    shadows.push({
      symbol,
      strategy_version: STRATEGY_VERSION,
      entry_price: evidence?.close ?? null,
      quote_observed_at: quote?.observedAt ?? null,
      spread_pct: spreadPct,
      geometry: { candle_source: source, candle_sources_attempted: attempted, expected_session: expectedSession, evidence, score: score ?? { ok: false, reason: baseReason }, execution_gate: baseReason },
      decision: "refused",
      refusal_reason: refusalReason,
      input_fingerprint: fingerprint,
    });
  }

  const fresh = rows.filter((row) => row.raw.observed_session === expectedSession).length;
  const { data: run, error: runError } = await supabase.from("crypto_universe_runs").insert({
    source: "public_candles_plus_robinhood_readonly_crypto_shadow",
    status: fresh === rows.length ? "partial" : "error",
    summary: {
      lane: "crypto_native_shadow", expected_session: expectedSession, symbols: rows.length, fresh_daily_evidence: fresh,
      executable_quotes: broker.quotes.size, broker_connected: broker.connected, broker_account_eligible: broker.accountEligible,
      broker_pair_inventory_observed: broker.pairInventoryObserved, broker_quote_tool_available: broker.quoteToolAvailable,
      broker_error_codes: broker.errorCodes, admitted: 0, live_execution_enabled: false,
    },
    error: fresh !== rows.length ? "one or more required daily candles were unavailable or stale"
      : !broker.pairInventoryObserved ? "broker pair inventory is not offered by the verified read contract; all candidates remain refused"
      : "broker pair and executable quote collection is not implemented",
  }).select("id").single();
  if (runError || !run) return NextResponse.json({ error: "crypto universe run write failed" }, { status: 500 });
  const { error: memberError } = await supabase.from("crypto_universe_members").insert(rows.map((row) => ({ ...row, run_id: run.id })));
  if (memberError) return NextResponse.json({ error: "crypto universe member write failed" }, { status: 500 });
  const { error: shadowError } = await supabase.from("crypto_geometry_shadows").upsert(shadows, { onConflict: "symbol,strategy_version,input_fingerprint", ignoreDuplicates: true });
  if (shadowError) return NextResponse.json({ error: "crypto shadow write failed" }, { status: 500 });
  return NextResponse.json({ success: true, run_id: run.id, expected_session: expectedSession, fresh_daily_evidence: fresh, admitted: 0, refusals: rows.map((row) => ({ symbol: row.symbol, reason: row.refusal_reason })) });
}

export async function GET(req: NextRequest) { return POST(req); }
