import { createHash } from "crypto";
import { NextRequest, NextResponse } from "next/server";
import { requireOwner } from "@/lib/auth/require-owner";
import { verifyCronSecret } from "@/lib/auth/cron";
import { createServiceClient } from "@/lib/supabase/service";
import { CRYPTO_SYMBOLS } from "@/lib/scoring/instrument-taxonomy";
import { scoreCryptoShadow } from "@/lib/scoring/crypto-score";
import { deriveCryptoResearchShadow } from "@/lib/scoring/crypto-research-shadow";
import { classifyCryptoCandidate } from "@/lib/scoring/crypto-candidate";
import { fetchCryptoCandles } from "@/lib/data/crypto-quotes";
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
  const inventory = broker.pairInventoryObserved
    ? [...broker.pairs.values()].sort((left, right) => left.symbol.localeCompare(right.symbol))
    : [...CRYPTO_SYMBOLS].map((symbol) => ({ symbol, brokerPair: `${symbol}-USD`, tradeable: false }));
  // The broker inventory decides the population. History pulls are intentionally
  // bounded and deterministic: if the broker offers more pairs than one run can
  // reasonably source, the lowest observed spreads are covered first and every
  // deferred pair is explicitly recorded rather than disappearing from the run.
  const targets = inventory
    .filter((pair) => broker.accountEligible && pair.tradeable && broker.quotes.has(pair.symbol))
    .sort((left, right) => {
      const leftQuote = broker.quotes.get(left.symbol)!;
      const rightQuote = broker.quotes.get(right.symbol)!;
      return ((leftQuote.ask - leftQuote.bid) / leftQuote.ask) - ((rightQuote.ask - rightQuote.bid) / rightQuote.ask)
        || left.symbol.localeCompare(right.symbol);
    })
    .slice(0, MAX_HISTORY_FETCHES_PER_RUN);
  const targetSymbols = new Set(targets.map((pair) => pair.symbol));
  const candleResults = new Map<string, Awaited<ReturnType<typeof fetchCryptoCandles>>>();
  for (const [index, result] of (await withConcurrency(targets, 3, (pair) => fetchCryptoCandles(pair.symbol, avKey ?? ""))).entries()) {
    candleResults.set(targets[index].symbol, result);
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
    const quote = broker.quotes.get(symbol);
    const spreadPct = quote ? ((quote.ask - quote.bid) / quote.ask) * 100 : null;
    const score = evidence ? scoreCryptoShadow({
      trendScore: evidence.trendScore,
      structureScore: evidence.structureScore,
      volatilityScore: evidence.volatilityScore,
      spreadPct,
      quoteAgeSeconds: quote ? 0 : null,
      maxSpreadPct: 0.5,
      maxQuoteAgeSeconds: 15,
    }) : null;
    const candidate = classifyCryptoCandidate({
      pairInventoryObserved: broker.pairInventoryObserved, accountEligible: broker.accountEligible,
      brokerTradeable: pair.tradeable, hasExecutableQuote: !!quote,
      historyDeferred: !targetSymbols.has(symbol), historyDays: completed.length,
      observedSession: last?.date ?? null, expectedSession, hasEvidence: !!evidence, score,
    });
    const decision = candidate.admitted ? "eligible" : "refused";
    const refusalReason = candidate.reason;
    const member: any = {
      symbol, broker_tradeable: pair.tradeable && broker.pairInventoryObserved, account_eligible: broker.accountEligible,
      history_days: completed.length, quote_observed_at: quote?.observedAt ?? null, bid: quote?.bid ?? null, ask: quote?.ask ?? null,
      spread_pct: spreadPct, admitted: candidate.admitted, refusal_reason: refusalReason,
      raw: {
        candle_source: source, candle_sources_attempted: attempted, expected_session: expectedSession,
        observed_session: last?.date ?? null, evidence, score: score ?? { ok: false, reason: refusalReason },
        broker: { pair: pair.brokerPair, connected: broker.connected, account_eligible: broker.accountEligible, pair_inventory_observed: broker.pairInventoryObserved, quote_tool_available: broker.quoteToolAvailable, quote_coverage_limited: broker.quoteCoverageLimited, error_codes: broker.errorCodes },
      },
    };
    rows.push(member);
    if (!targetSymbols.has(symbol)) continue;
    const fingerprint = createHash("sha256")
      .update(JSON.stringify({ symbol, strategy: STRATEGY_VERSION, expectedSession, close: evidence?.close ?? null, source, attempted, quote: quote ? { bid: quote.bid, ask: quote.ask, observedAt: quote.observedAt } : null, refusalReason }))
      .digest("hex");
    shadows.push({
      symbol,
      strategy_version: STRATEGY_VERSION,
      entry_price: evidence?.close ?? null,
      quote_observed_at: quote?.observedAt ?? null,
      spread_pct: spreadPct,
      geometry: { candle_source: source, candle_sources_attempted: attempted, expected_session: expectedSession, evidence, score: score ?? { ok: false, reason: refusalReason }, execution_gate: refusalReason ?? "native_candidate_measure_only" },
      decision,
      refusal_reason: refusalReason,
      input_fingerprint: fingerprint,
    });
  }

  const fresh = rows.filter((row) => targetSymbols.has(row.symbol) && row.raw.observed_session === expectedSession).length;
  const admitted = rows.filter((row) => row.admitted).length;
  const fullQuoteCoverage = !broker.quoteCoverageLimited && targets.length === inventory.filter((pair) => pair.tradeable).length;
  const { data: run, error: runError } = await supabase.from("crypto_universe_runs").insert({
    source: "public_candles_plus_robinhood_readonly_crypto_shadow",
    status: targets.length === 0 || fresh !== targets.length ? (targets.length === 0 ? "partial" : "error")
      : broker.pairInventoryObserved && fullQuoteCoverage ? "done" : "partial",
    summary: {
      lane: "crypto_native_shadow", expected_session: expectedSession, broker_pairs: inventory.length, research_targets: targets.length, fresh_daily_evidence: fresh,
      executable_quotes: broker.quotes.size, broker_connected: broker.connected, broker_account_eligible: broker.accountEligible,
      broker_pair_inventory_observed: broker.pairInventoryObserved, broker_quote_tool_available: broker.quoteToolAvailable,
      broker_error_codes: broker.errorCodes, admitted, live_execution_enabled: false,
    },
    error: targets.length === 0 ? "no broker-eligible pair with an observed executable quote; no history pull was attempted"
      : fresh !== targets.length ? "one or more required daily candles were unavailable or stale"
      : !broker.pairInventoryObserved ? "broker pair inventory is not offered by the verified read contract; all candidates remain refused"
      : !fullQuoteCoverage ? "not every broker-tradeable pair had an observed executable quote; uncovered pairs remain explicitly deferred"
      : null,
  }).select("id").single();
  if (runError || !run) return NextResponse.json({ error: "crypto universe run write failed" }, { status: 500 });
  const { error: memberError } = await supabase.from("crypto_universe_members").insert(rows.map((row) => ({ ...row, run_id: run.id })));
  if (memberError) return NextResponse.json({ error: "crypto universe member write failed" }, { status: 500 });
  const { error: shadowError } = await supabase.from("crypto_geometry_shadows").upsert(shadows, { onConflict: "symbol,strategy_version,input_fingerprint", ignoreDuplicates: true });
  if (shadowError) return NextResponse.json({ error: "crypto shadow write failed" }, { status: 500 });
  if (!broker.pairInventoryObserved || targets.length === 0) {
    await reportIssue({
      issueKey: "crypto-native-universe-coverage",
      severity: "info",
      category: "broker",
      title: "Crypto native research has no currently eligible broker pair",
      detail: !broker.pairInventoryObserved
        ? "Robinhood did not return a parseable USD-pair inventory. Crypto paper and live execution remain blocked."
        : "No broker pair simultaneously had explicit tradability, account eligibility, and a current two-sided quote. The collector recorded each refusal.",
      autoExpireAt: new Date(Date.now() + 48 * 60 * 60 * 1000).toISOString(),
    }, supabase);
  } else {
    await resolveIssue("crypto-native-universe-coverage", supabase);
  }
  return NextResponse.json({ success: true, run_id: run.id, expected_session: expectedSession, fresh_daily_evidence: fresh, admitted, refusals: rows.filter((row) => !row.admitted).map((row) => ({ symbol: row.symbol, reason: row.refusal_reason })) });
}

export async function GET(req: NextRequest) { return POST(req); }
