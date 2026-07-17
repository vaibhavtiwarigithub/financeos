// Daily Per-Holding Risk Analytics — compute cron.
//
// Spec: features/holding-risk-daily/FEATURE_ARCHITECTURE.md ("Cron" + "Compute path").
//
// POST /api/agents/holding-risk?market=us|india  (cron-secret gated)
//
// One account = one run. For each live account in the requested market we:
//   1. capture ONE coherent, bounded input snapshot (holdings + as-of time) — a
//      single account's timestamp is never combined with another account's holdings;
//   2. acquire the append-only run CLAIM (claim_holding_risk_run) BEFORE any external
//      or LLM work, so a retried/duplicate cron loses the unique-insert race and never
//      double-publishes;
//   3. compute the deterministic per-holding score/posture (computeHoldingRisk) +
//      computed aligned-return correlation clusters (computeCorrelationClusters);
//   4. run a BEST-EFFORT batched LLM prose pass that writes only `strategy_note` and
//      can NEVER alter a number, score, posture, or action;
//   5. publish snapshots + the account roll-up in ONE transaction (publish_holding_risk_run).
//
// Security invariants enforced here:
//   • Read-only. This route places/previews/cancels NO broker order. `add_capacity`
//     means risk room exists, never "buy".
//   • Kite must resolve a BROKER-VERIFIED user_id (verifyKiteTradingIdentity) or the
//     India-Kite account fails closed and is skipped — the placeholder "kite_india"
//     can never claim a run.
//   • No cross-currency roll-up: US → USD, India → INR, computed independently.
//   • Stale / errored account snapshots are skipped (reported), never published as
//     yesterday's risk.

import { NextRequest, NextResponse } from "next/server";
import { createHash } from "crypto";
import { createServiceClient } from "@/lib/supabase/service";
import { verifyCronSecret } from "@/lib/auth/cron";
import {
  fetchRobinhoodBrokerAccounts,
  fetchKiteBrokerAccount,
  fetchAllAccounts,
  type BrokerAccount,
  type BrokerHolding,
} from "@/lib/brokers";
import { verifyKiteTradingIdentity } from "@/lib/kite";
import { computeRiskMetrics } from "@/lib/portfolio-risk";
import { fetchUsCandles } from "@/lib/data/candles";
import { fetchIndiaCandles } from "@/lib/india-data";
import { computeCorrelationClusters } from "@/lib/risk/correlation";
import {
  computeHoldingRisk,
  HOLDING_RISK_FORMULA_VERSION,
  type HoldingRiskLimits,
  type HoldingRiskInput,
  type HoldingRiskContext,
} from "@/lib/risk/holding-risk";
import { allocateSectorBreach } from "@/lib/risk/sector-breach";
import { strategyNotes } from "@/lib/risk/strategy-notes";
import { DEFAULT_LIMITS } from "@/lib/portfolio/constructor";
import type { Candle } from "@/lib/data/technicals";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

// The ONLY account permitted to place an order (CLAUDE.md / docs/arch/08 account
// allowlist). Every other account — including `965848641`, where the AVGO advice
// that motivated the breach allocator was shown — is read-only: its postures are
// informational, and the action reason says so. This feature calls no order path
// for ANY account; this flag only tells the owner whether one exists.
const ORDER_PATH_ACCOUNTS = new Set(["605420660"]);

// Market-local completed-session date (YYYY-MM-DD). en-CA gives ISO ordering; the
// timeZone anchors "which trading day" to the market, not the server's UTC clock.
function marketSessionDate(market: "us" | "india", now: Date): string {
  const tz = market === "india" ? "Asia/Kolkata" : "America/New_York";
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit",
  }).format(now);
}

// Daily realized volatility as a percent, from real price history. Std-dev of daily
// simple returns × 100. Returns null when there aren't enough clean candles.
function realizedVolPct(candles: Candle[]): number | null {
  const closes = candles
    .filter(c => Number.isFinite(c.close) && c.close > 0)
    .map(c => c.close);
  if (closes.length < 20) return null;
  const rets: number[] = [];
  for (let i = 1; i < closes.length; i++) rets.push((closes[i] - closes[i - 1]) / closes[i - 1]);
  if (rets.length < 15) return null;
  const mean = rets.reduce((s, v) => s + v, 0) / rets.length;
  const varr = rets.reduce((s, v) => s + (v - mean) * (v - mean), 0) / rets.length;
  const vol = Math.sqrt(varr) * 100;
  return Number.isFinite(vol) ? vol : null;
}

// Stable content hash of the input snapshot. Same holdings + same as-of time →
// same run_key, so a retried cron is idempotent (claim reads the existing run back).
function inputHash(account: BrokerAccount): string {
  const rows = [...account.holdings]
    .sort((a, b) => (a.symbol < b.symbol ? -1 : a.symbol > b.symbol ? 1 : 0))
    .map(h => `${h.symbol}|${h.qty}|${h.currentPrice}|${h.marketValue}`);
  const payload = JSON.stringify({
    total: account.totalValue, at: account.fetchedAt, rows,
  });
  return createHash("sha256").update(payload).digest("hex").slice(0, 32);
}

async function loadLimits(svc: any, market: "us" | "india"): Promise<HoldingRiskLimits> {
  const { data: cfg } = await svc
    .from("strategy_config")
    .select("max_gross_exposure_pct,max_sector_exposure_pct,max_name_exposure_pct,max_portfolio_vol_pct,max_avg_pairwise_corr")
    .limit(1).maybeSingle();
  return {
    maxGrossExposurePct: Number((cfg as any)?.max_gross_exposure_pct) || DEFAULT_LIMITS.maxGrossExposurePct,
    maxSectorExposurePct: Number((cfg as any)?.max_sector_exposure_pct) || DEFAULT_LIMITS.maxSectorExposurePct,
    maxNameExposurePct: Number((cfg as any)?.max_name_exposure_pct) || DEFAULT_LIMITS.maxNameExposurePct,
    maxPortfolioVolPct: Number((cfg as any)?.max_portfolio_vol_pct) || DEFAULT_LIMITS.maxPortfolioVolPct,
    maxAvgPairwiseCorr: Number((cfg as any)?.max_avg_pairwise_corr) || DEFAULT_LIMITS.maxAvgPairwiseCorr,
  };
}

interface AccountOutcome {
  accountId: string;
  broker: string;
  label: string;
  status: "complete" | "skipped";
  holdings?: number;
  reason?: string;
}

async function processAccount(
  svc: any,
  account: BrokerAccount,
  ctx: { market: "us" | "india"; currency: "USD" | "INR"; capturedOn: string; limits: HoldingRiskLimits; accountId: string },
): Promise<AccountOutcome> {
  const { market, currency, capturedOn, limits, accountId } = ctx;
  const broker = account.source;
  const label = account.accountLabel ?? broker;

  // Stale / errored snapshot → skip. Never publish yesterday's data.
  if (account.error) {
    return { accountId, broker, label, status: "skipped", reason: `snapshot error: ${account.error}` };
  }

  const hash = inputHash(account);
  const runKey = `${market}:${accountId}:${capturedOn}:${HOLDING_RISK_FORMULA_VERSION}:${hash}`;

  // 1. CLAIM before any external/LLM work.
  const { data: claim, error: claimErr } = await svc.rpc("claim_holding_risk_run", {
    p_run_key: runKey,
    p_market: market,
    p_currency: currency,
    p_broker: broker,
    p_account_id: accountId,
    p_account_label: label,
    p_captured_on: capturedOn,
    p_formula_version: HOLDING_RISK_FORMULA_VERSION,
  });
  if (claimErr) {
    return { accountId, broker, label, status: "skipped", reason: `claim failed: ${claimErr.message}` };
  }
  const claimRow = Array.isArray(claim) ? claim[0] : claim;
  const runId: string = claimRow?.run_id;
  // Idempotency: only the claimer of a 'running' run proceeds. Anyone reading back a
  // run that already exists (running elsewhere, or already complete) stands down.
  if (!claimRow?.is_new || claimRow?.status !== "running") {
    return { accountId, broker, label, status: "skipped", reason: `already claimed (${claimRow?.status ?? "unknown"})` };
  }

  const sourceCapturedAt = account.fetchedAt;
  const accountTotal = account.totalValue;

  // Account roll-up (sector/beta enrichment + persisted RiskMetrics).
  const metrics = await computeRiskMetrics(account.holdings, undefined, { market });
  const enriched = new Map<string, { sector: string; beta: number }>();
  for (const h of metrics.holdings) enriched.set(h.symbol, { sector: h.sector, beta: h.beta });

  // ── Deterministic sector-cap breach allocation (risk-internal; no LLM, no
  // research score). A sector breach is a SECTOR property — this decides WHICH
  // names absorb it and HOW MUCH each gives up, so no name gets a blanket "trim".
  //
  // NAV basis: `account.totalValue` is cash-inclusive, matching how the owner's
  // sector cap is enforced on the live money path (lib/risk/live-portfolio-gate.ts
  // builds the book as value/NAV) and how the name cap is scored in holding-risk.
  // NOTE: metrics.sectorBreakdown[].weightPct is INVESTED-relative and is left
  // alone for the roll-up display — the risk engine must not mix the two bases.
  const breach = allocateSectorBreach({
    positions: account.holdings.map(h => ({
      symbol: h.symbol,
      sector: enriched.get(h.symbol)?.sector ?? null,
      marketValue: h.marketValue,
    })),
    navValue: accountTotal,
    maxSectorExposurePct: limits.maxSectorExposurePct,
    currency,
    market,
  });
  const sectorNavWeight = new Map<string, number>(); // sector -> fraction of NAV
  for (const s of breach.sectors) sectorNavWeight.set(s.sector, s.sectorWeightPct / 100);

  // Read-only unless this is the one order-permitted account. This feature places
  // no order either way; the flag only labels whether an order path exists.
  const readOnlyAccount = !ORDER_PATH_ACCOUNTS.has(accountId);

  // Fetch candles for every held symbol (bounded: one account's holdings).
  const candlesBySymbol = new Map<string, Candle[]>();
  await Promise.all(account.holdings.map(async (h) => {
    try {
      const candles = market === "india"
        ? await fetchIndiaCandles(h.symbol)
        : (await fetchUsCandles(h.symbol, async () => [] as Candle[])).candles;
      candlesBySymbol.set(h.symbol, candles ?? []);
    } catch {
      candlesBySymbol.set(h.symbol, []);
    }
  }));

  // Computed aligned-return correlation clusters (never KNOWN_CORR alone).
  const weightBySymbol = new Map<string, number>();
  for (const h of account.holdings) {
    weightBySymbol.set(h.symbol, accountTotal > 0 ? h.marketValue / accountTotal : 0);
  }
  const corrLimitFrac = limits.maxAvgPairwiseCorr > 0 && limits.maxAvgPairwiseCorr <= 1 ? limits.maxAvgPairwiseCorr : 0.6;
  const clusters = computeCorrelationClusters(candlesBySymbol, weightBySymbol, { threshold: corrLimitFrac });

  // Gross exposure fraction = invested / total (cash-inclusive total).
  const invested = account.holdings.reduce((s, h) => s + h.marketValue, 0);
  const grossExposurePct = accountTotal > 0 ? invested / accountTotal : null;

  // 3. Deterministic per-holding compute.
  const computed = account.holdings.map((h: BrokerHolding) => {
    const enr = enriched.get(h.symbol);
    const sector = enr?.sector ?? null;
    const vol = realizedVolPct(candlesBySymbol.get(h.symbol) ?? []);
    const cluster = clusters.get(h.symbol);

    const input: HoldingRiskInput = {
      symbol: h.symbol,
      qty: h.qty,
      currentPrice: h.currentPrice,
      marketValue: h.marketValue,
      averageCost: h.costBasis != null && h.qty > 0 ? h.costBasis / h.qty : null,
      unrealizedPnlPct: h.unrealizedPnlPct != null ? h.unrealizedPnlPct / 100 : null, // percent → fraction
      sector,
      beta: enr?.beta ?? null,
      realizedVolPct: vol,
    };
    const hctx: HoldingRiskContext = {
      accountTotalValue: accountTotal,
      currency,
      limits,
      quoteFresh: true, // just-fetched broker snapshot
      sectorWeightPct: sector && sector !== "Other" ? (sectorNavWeight.get(sector) ?? null) : null,
      sectorBreachAllocation: breach.bySymbol.get(h.symbol) ?? null,
      readOnlyAccount,
      grossExposurePct,
      clusterAvgCorr: cluster?.avgCorr ?? null,
      clusterPeers: cluster?.peers ?? [],
      clusterWeightPct: cluster?.clusterWeightPct ?? null,
      // No verified protective-stop / thesis / event feed queried in this pass → left
      // missing (honest): drawdown/stop uses cost basis only, liquidity/event excluded.
    };
    return { holding: h, sector, enr, vol, result: computeHoldingRisk(input, hctx) };
  });

  // 4. Best-effort LLM prose. Handed the FIXED verdict as read-only context; it
  //    writes only `strategy_note` and can never alter a number, score, posture,
  //    action, or allocation (lib/risk/strategy-notes.ts).
  const notes = await strategyNotes(market, label, computed.map(c => ({
    symbol: c.holding.symbol,
    result: c.result,
    weightPct: weightBySymbol.get(c.holding.symbol) ?? 0,
    sector: c.sector,
  })));

  // Assemble per-holding payload.
  const holdingsPayload = computed.map(c => {
    const h = c.holding;
    return {
      symbol: h.symbol,
      source: h.source,
      sector: c.sector,
      qty: h.qty,
      current_price: h.currentPrice,
      average_cost: h.costBasis != null && h.qty > 0 ? h.costBasis / h.qty : null,
      market_value: h.marketValue,
      // NAV basis — same denominator as the name cap and the breach allocation.
      weight_pct: weightBySymbol.get(h.symbol) ?? (accountTotal > 0 ? h.marketValue / accountTotal : null),
      beta: c.enr?.beta ?? null,
      realized_vol_pct: c.vol,
      unrealized_pnl_pct: h.unrealizedPnlPct ?? null,
      holding_risk_score: c.result.score,
      risk_label: c.result.label,
      risk_drivers: c.result.drivers,
      risk_posture: c.result.riskPosture,
      action_reason: c.result.actionReason,
      add_capacity: c.result.addCapacity,
      data_confidence: c.result.dataConfidence,
      missing_inputs: c.result.missingInputs,
      strategy_note: notes.get(h.symbol) ?? null,
    };
  });

  // Run-level confidence = mean of scored holdings' confidence; union of missing inputs.
  const confidences = computed.map(c => c.result.dataConfidence);
  const runConfidence = confidences.length ? confidences.reduce((s, v) => s + v, 0) / confidences.length : null;
  const missingUnion = Array.from(new Set(computed.flatMap(c => c.result.missingInputs)));

  const accountPayload = {
    metrics,
    total_value: accountTotal,
  };

  // 5. Transactional publish (snapshots + roll-up + running→complete).
  const { error: pubErr } = await svc.rpc("publish_holding_risk_run", {
    p_run_id: runId,
    p_status: "complete",
    p_source_captured_at: sourceCapturedAt,
    p_input_hash: hash,
    p_data_confidence: runConfidence,
    p_missing_inputs: missingUnion,
    p_error: null,
    p_holdings: holdingsPayload,
    p_account: accountPayload,
  });
  if (pubErr) {
    return { accountId, broker, label, status: "skipped", reason: `publish failed: ${pubErr.message}` };
  }

  return { accountId, broker, label, status: "complete", holdings: holdingsPayload.length };
}

export async function POST(req: NextRequest) {
  if (!verifyCronSecret(req)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const marketParam = req.nextUrl.searchParams.get("market");
  if (marketParam !== "us" && marketParam !== "india") {
    return NextResponse.json({ error: "invalid_market: expected market=us|india" }, { status: 400 });
  }
  const market = marketParam;
  const currency: "USD" | "INR" = market === "india" ? "INR" : "USD";

  const svc = createServiceClient();
  const capturedOn = marketSessionDate(market, new Date());
  const limits = await loadLimits(svc, market);

  const outcomes: AccountOutcome[] = [];

  // Gather this market's accounts. Each is processed independently — one account's
  // timestamp is never combined with another's holdings.
  const accounts: Array<{ account: BrokerAccount; accountId: string }> = [];

  if (market === "us") {
    const [rh, others] = await Promise.all([
      fetchRobinhoodBrokerAccounts().catch(() => [] as BrokerAccount[]),
      fetchAllAccounts("us").catch(() => [] as BrokerAccount[]),
    ]);
    for (const a of [...rh, ...others]) {
      const id = a.accountId ?? a.source;
      if (!id || id === "unknown") {
        outcomes.push({ accountId: id ?? "?", broker: a.source, label: a.accountLabel ?? a.source, status: "skipped", reason: "no broker-verified account id" });
        continue;
      }
      accounts.push({ account: a, accountId: id });
    }
  } else {
    // India: Kite requires a BROKER-VERIFIED user_id — fail closed on any mismatch.
    const identity = await verifyKiteTradingIdentity(svc);
    if (identity.ok) {
      const kite = await fetchKiteBrokerAccount().catch((e) => ({
        source: "kite", accountId: identity.account, accountLabel: "Kite India",
        totalValue: 0, cashBalance: 0, holdings: [], fetchedAt: new Date().toISOString(),
        error: e?.message ?? String(e),
      } as BrokerAccount));
      // Replace the placeholder "kite_india" with the verified user_id.
      accounts.push({ account: { ...kite, accountId: identity.account }, accountId: identity.account });
    } else {
      outcomes.push({ accountId: "kite", broker: "kite", label: "Kite India", status: "skipped", reason: `identity unverified (fail-closed): ${identity.error}` });
    }
    const others = await fetchAllAccounts("india").catch(() => [] as BrokerAccount[]);
    for (const a of others) {
      const id = a.accountId ?? a.source;
      if (!id || id === "unknown") {
        outcomes.push({ accountId: id ?? "?", broker: a.source, label: a.accountLabel ?? a.source, status: "skipped", reason: "no broker-verified account id" });
        continue;
      }
      accounts.push({ account: a, accountId: id });
    }
  }

  for (const { account, accountId } of accounts) {
    try {
      outcomes.push(await processAccount(svc, account, { market, currency, capturedOn, limits, accountId }));
    } catch (e: any) {
      outcomes.push({ accountId, broker: account.source, label: account.accountLabel ?? account.source, status: "skipped", reason: `error: ${e?.message ?? String(e)}` });
    }
  }

  const completed = outcomes.filter(o => o.status === "complete").length;
  return NextResponse.json({
    ok: true,
    market,
    captured_on: capturedOn,
    formula_version: HOLDING_RISK_FORMULA_VERSION,
    accounts_completed: completed,
    accounts_total: outcomes.length,
    outcomes,
  });
}
