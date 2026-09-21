import { createHash } from "crypto";
import { NextRequest, NextResponse } from "next/server";
import { requireOwner } from "@/lib/auth/require-owner";
import { verifyCronSecret } from "@/lib/auth/cron";
import { createServiceClient } from "@/lib/supabase/service";
import { CRYPTO_SYMBOLS } from "@/lib/scoring/instrument-taxonomy";
import { scoreCryptoShadow } from "@/lib/scoring/crypto-score";
import { deriveCryptoResearchShadow } from "@/lib/scoring/crypto-research-shadow";
import { classifyCryptoPaperCandidate } from "@/lib/scoring/crypto-candidate";
import { cryptoResearchInventory } from "@/lib/scoring/crypto-research-inventory";
import { fetchCryptoCandles, fetchCryptoQuote } from "@/lib/data/crypto-quotes";
import { cryptoCompletedCandles, cryptoSessionDate } from "@/lib/data/crypto-session";
import { readRobinhoodCryptoExecutionSnapshot } from "@/lib/robinhood-mcp";
import { reportIssue, resolveIssue } from "@/lib/system-health";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const STRATEGY_VERSION = "crypto-native-daily-shadow-v1";
const MAX_HISTORY_FETCHES_PER_RUN = 12;

async function withConcurrency<T, R>(items: readonly T[], limit: number, work: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await work(items[index]);
    }
  }));
  return results;
}

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
  // separately from public historical candles. A successful candidate is still
  // measure-only: this route has no paper or live execution authority.
  const broker = await readRobinhoodCryptoExecutionSnapshot([...CRYPTO_SYMBOLS]);
  const inventory = cryptoResearchInventory(broker.pairInventoryObserved ? [...broker.pairs.values()] : []);
  // Prioritize the approved paper basket, then remaining pairs deterministically.
  // Missing broker membership does not authorize live execution.
  const targets = inventory.slice(0, MAX_HISTORY_FETCHES_PER_RUN);
  const targetSymbols = new Set(targets.map((pair) => pair.symbol));
  const candleResults = new Map<string, Awaited<ReturnType<typeof fetchCryptoCandles>>>();
  const quoteResults = new Map<string, Awaited<ReturnType<typeof fetchCryptoQuote>>>();
  for (const [index, result] of (await withConcurrency(targets, 3, async (pair) => ({ candles: await fetchCryptoCandles(pair.symbol, avKey ?? ""), quote: await fetchCryptoQuote(pair.symbol) }))).entries()) {
    candleResults.set(targets[index].symbol, result.candles);
    quoteResults.set(targets[index].symbol, result.quote);
  }
  const rows: any[] = [];
  const shadows: any[] = [];

  for (const pair of inventory) {
    const symbol = pair.symbol;
    const result = candleResults.get(symbol);
    const { candles, source, attempted } = result ?? { candles: [], source: "unavailable" as const, attempted: [] };
    const completed = cryptoCompletedCandles(candles);
    const last = completed.at(-1);
    const evidence = last?.date === expectedSession ? deriveCryptoResearchShadow(completed) : null;
    const marketQuote = quoteResults.get(symbol)?.quote ?? null;
    const brokerQuote = broker.quotes.get(symbol);
    const spreadPct = marketQuote ? ((marketQuote.ask - marketQuote.bid) / marketQuote.ask) * 100 : null;
    const score = evidence ? scoreCryptoShadow({
      trendScore: evidence.trendScore,
      structureScore: evidence.structureScore,
      volatilityScore: evidence.volatilityScore,
      spreadPct,
      quoteAgeSeconds: marketQuote ? 0 : null,
      maxSpreadPct: 0.5,
      maxQuoteAgeSeconds: 15,
    }) : null;
    const candidate = classifyCryptoPaperCandidate({
      hasMarketQuote: !!marketQuote,
      historyDeferred: !targetSymbols.has(symbol), historyDays: completed.length,
      observedSession: last?.date ?? null, expectedSession, hasEvidence: !!evidence, score,
    });
    const decision = candidate.admitted ? "eligible" : "refused";
    const refusalReason = candidate.reason;
    const member: any = {
      symbol, broker_tradeable: pair.tradeable && broker.pairInventoryObserved, account_eligible: broker.accountEligible,
      history_days: completed.length, quote_observed_at: marketQuote?.observedAt ?? null, bid: marketQuote?.bid ?? null, ask: marketQuote?.ask ?? null,
      spread_pct: spreadPct, admitted: candidate.admitted, refusal_reason: refusalReason,
      raw: {
        candle_source: source, candle_sources_attempted: attempted, expected_session: expectedSession,
        observed_session: last?.date ?? null, evidence, score: score ?? { ok: false, reason: refusalReason },
        public_quote: { source: marketQuote?.source ?? "unavailable", attempted: quoteResults.get(symbol)?.attempted ?? [] },
        broker: { pair: pair.brokerPair, connected: broker.connected, account_eligible: broker.accountEligible, pair_inventory_observed: broker.pairInventoryObserved, quote_tool_available: broker.quoteToolAvailable, quote_coverage_limited: broker.quoteCoverageLimited, error_codes: broker.errorCodes, live_order_ready: broker.pairInventoryObserved && broker.accountEligible && pair.tradeable && !!brokerQuote },
      },
    };
    rows.push(member);
    if (!targetSymbols.has(symbol)) continue;
    const fingerprint = createHash("sha256")
      .update(JSON.stringify({ symbol, strategy: STRATEGY_VERSION, expectedSession, close: evidence?.close ?? null, source, attempted, quote: marketQuote ? { bid: marketQuote.bid, ask: marketQuote.ask, observedAt: marketQuote.observedAt, source: marketQuote.source } : null, refusalReason }))
      .digest("hex");
    shadows.push({
      symbol,
      strategy_version: STRATEGY_VERSION,
      entry_price: evidence?.close ?? null,
      quote_observed_at: marketQuote?.observedAt ?? null,
      spread_pct: spreadPct,
      geometry: { candle_source: source, candle_sources_attempted: attempted, expected_session: expectedSession, evidence, score: score ?? { ok: false, reason: refusalReason }, public_quote: { source: marketQuote?.source ?? "unavailable", observed_at: marketQuote?.observedAt ?? null }, execution_gate: refusalReason ?? "native_candidate_measure_only" },
      decision,
      refusal_reason: refusalReason,
      input_fingerprint: fingerprint,
    });
  }

  const fresh = rows.filter((row) => targetSymbols.has(row.symbol) && row.raw.observed_session === expectedSession).length;
  const admitted = rows.filter((row) => row.admitted).length;
  const { data: run, error: runError } = await supabase.from("crypto_universe_runs").insert({
    source: "public_candles_plus_robinhood_readonly_crypto_shadow",
    status: targets.length > 0 && fresh === targets.length ? "done" : "partial",
    summary: {
      lane: "crypto_native_shadow", expected_session: expectedSession, broker_pairs: inventory.length, research_targets: targets.length, fresh_daily_evidence: fresh,
      executable_quotes: broker.quotes.size, broker_connected: broker.connected, broker_account_eligible: broker.accountEligible,
      broker_pair_inventory_observed: broker.pairInventoryObserved, broker_quote_tool_available: broker.quoteToolAvailable,
      broker_error_codes: broker.errorCodes, admitted, live_execution_enabled: false,
    },
    error: targets.length === 0 ? "no configured crypto research target"
      : fresh !== targets.length ? "one or more required daily candles were unavailable or stale"
      : null,
  }).select("id").single();
  if (runError || !run) return NextResponse.json({ error: "crypto universe run write failed" }, { status: 500 });
  const { error: memberError } = await supabase.from("crypto_universe_members").insert(rows.map((row) => ({ ...row, run_id: run.id })));
  if (memberError) return NextResponse.json({ error: "crypto universe member write failed" }, { status: 500 });
  const { error: shadowError } = await supabase.from("crypto_geometry_shadows").upsert(shadows, { onConflict: "symbol,strategy_version,input_fingerprint", ignoreDuplicates: true });
  if (shadowError) return NextResponse.json({ error: "crypto shadow write failed" }, { status: 500 });
  // Native crypto research owns its own signals. Do not feed these through the
  // equity scorer or label them deterministic_v1: the paper trader consumes
  // only this provenance tag, while the equity PaperTrader cannot select it.
  for (const row of rows.filter((candidate) => candidate.admitted)) {
    const score = row.raw?.score;
    await supabase.from("agent_signals").update({ status: "superseded" })
      .eq("market", "us").eq("symbol", row.symbol).eq("status", "pending").eq("score_source", "crypto_native_shadow_v1");
    const { error: signalError } = await supabase.from("agent_signals").insert({
      symbol: row.symbol, market: "us", direction: "long", analyst_score: Math.round(score.score), conviction: Math.round(score.score),
      agent_type: "crypto_research", agent_label: "crypto_native", status: "pending", session_validated: true,
      // source is discovery provenance (DB CHECK: holding/watchlist/screener).
      // The native pipeline identity belongs in score_source, not source.
      as_of_session: expectedSession, source: "screener", score_source: "crypto_native_shadow_v1", scoring_version: STRATEGY_VERSION,
      asset_class: "crypto", rationale: `Native crypto score ${score.score}: trend ${score.components.trend}, structure ${score.components.structure}, volatility ${score.components.volatility}; public ${row.raw.public_quote.source} quote.`,
      signal_breakdown: { crypto_native: row.raw.evidence, score, public_quote: row.raw.public_quote },
    });
    if (signalError) return NextResponse.json({ error: `crypto native signal write failed: ${signalError.message}` }, { status: 500 });
  }
  if (!broker.pairInventoryObserved || targets.length === 0) {
    await reportIssue({
      issueKey: "crypto-native-universe-coverage",
      severity: "info",
      category: "broker",
      title: "Crypto native research has no currently eligible broker pair",
      detail: !broker.pairInventoryObserved
        ? "Robinhood did not return a parseable USD-pair inventory. Public-market paper research continues; live execution remains blocked."
        : "No broker pair simultaneously had explicit tradability, account eligibility, and a current two-sided quote. The collector recorded each refusal.",
      autoExpireAt: new Date(Date.now() + 48 * 60 * 60 * 1000).toISOString(),
    }, supabase);
  } else {
    await resolveIssue("crypto-native-universe-coverage", supabase);
  }
  return NextResponse.json({ success: true, run_id: run.id, expected_session: expectedSession, fresh_daily_evidence: fresh, admitted, refusals: rows.filter((row) => !row.admitted).map((row) => ({ symbol: row.symbol, reason: row.refusal_reason })) });
}

export async function GET(req: NextRequest) { return POST(req); }
