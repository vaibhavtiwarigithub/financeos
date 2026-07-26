// Shared server-only order-execution service (audit R13). This is the SINGLE
// implementation of the hardened live-order invariant set, used by BOTH the
// owner manual gateway (app/api/broker/orders) and — in a later step — the
// autonomous worker. Extracted verbatim from the manual gateway so manual
// behavior is unchanged; the ONLY additions are (a) an actor envelope and
// (b) rejecting owner-only risk overrides for a non-owner actor.
//
// It returns a typed result; the HTTP layer maps it to a NextResponse. There is
// no NextResponse in here on purpose — the same service must serve a cron.
import { getActiveBrokerForOrder } from "@/lib/brokers/registry";
import { isIndia, fetchIndiaQuote } from "@/lib/india-data";
import { checkKillSwitches } from "@/lib/kill-switches";
import { checkLivePortfolioLimits } from "@/lib/risk/live-portfolio-gate";
import { getQuote } from "@/lib/data/quotes";
import { robinhoodHeldQty } from "@/lib/robinhood-mcp";
import { getKiteHoldings } from "@/lib/kite";
import { reportIssue } from "@/lib/system-health";
import { liveOrdersAllowed, autonomousWorkerAllowed } from "@/lib/autonomy";
import { isSymbolBlocked } from "@/lib/trading/symbol-policy";
import { isEtfSymbol } from "@/lib/asset-classification";
import { isTradingEnabled } from "@/lib/market-controls";

// Fraction of live equity used as the default per-order notional ceiling when
// strategy_config.max_order_notional is null.
const DEFAULT_NOTIONAL_FRAC = 0.15;
// Reject a live order if the fresh quote has drifted more than this from the
// price the proposal was approved at (matches trader/route.ts's approval gate).
const MAX_PRICE_DRIFT = 0.03;
const SYMBOL_RE = /^[A-Z.\-]{1,10}$/;
const PAPER_POSITION_PRICE_MAX_AGE_MS = 36 * 60 * 60 * 1000;
const LIVE_SNAPSHOT_MAX_AGE_MS = 6 * 60 * 60 * 1000;

// Adapter id → the brokerage key used in the broker_accounts allowlist.
function allowlistBrokerKey(brokerId: string): string {
  return brokerId === "robinhood_mcp" ? "robinhood" : brokerId;
}

type FundClassification = { ok: true; isFund: boolean } | { ok: false; error: string };

// Static symbols cover established funds, while ResearchAgent's persisted asset
// class covers newer symbols. Unknown is intentionally a refusal for a BUY: an
// allocation safety gate cannot safely assume an unknown instrument is equity.
async function classifyUsFund(svc: any, symbol: string): Promise<FundClassification> {
  if (isEtfSymbol(symbol)) return { ok: true, isFund: true };
  try {
    const { data, error } = await svc.from("agent_signals")
      .select("asset_class")
      .eq("market", "us")
      .eq("symbol", symbol)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error) return { ok: false, error: `asset classification read failed: ${error.message}` };
    const assetClass = String((data as any)?.asset_class ?? "");
    if (assetClass === "etf" || assetClass === "metal") return { ok: true, isFund: true };
    if (assetClass === "us_equity") return { ok: true, isFund: false };
    return { ok: false, error: `asset class for ${symbol} is unknown; refresh research before buying` };
  } catch (e) {
    return { ok: false, error: `asset classification error: ${String(e)}` };
  }
}

async function fundValueFromPositions(svc: any, positions: any[]): Promise<{ ok: true; value: number } | { ok: false; error: string }> {
  let value = 0;
  for (const position of positions) {
    const symbol = String(position?.symbol ?? position?.ticker ?? "").trim().toUpperCase();
    if (!symbol) return { ok: false, error: "position without a symbol prevents ETF allocation validation" };
    const classification = await classifyUsFund(svc, symbol);
    if (!classification.ok) return classification;
    if (!classification.isFund) continue;
    const qty = Number(position?.qty);
    const price = Number(position?.current_price);
    if (!Number.isFinite(qty) || qty < 0 || !Number.isFinite(price) || price <= 0) {
      return { ok: false, error: `unpriceable fund position ${symbol} prevents ETF allocation validation` };
    }
    value += qty * price;
  }
  return { ok: true, value };
}

// Resolve the live trading account for a market from the broker_accounts
// allowlist. FAIL CLOSED: any error, a missing selection, or an account that
// isn't role='trading' aborts — no silent fallback (unlike broker selection).
async function resolveTradingAccount(svc: any, market: "us" | "india", brokerKey: string): Promise<{ ok: true; account: string } | { ok: false; error: string }> {
  try {
    const col = market === "india" ? "active_account_india" : "active_account_us";
    const { data: cfg, error: cfgErr } = await svc.from("strategy_config").select(col).limit(1).maybeSingle();
    if (cfgErr) return { ok: false, error: `account config read failed: ${cfgErr.message}` };
    const account = (cfg as any)?.[col];
    if (!account) return { ok: false, error: `No active trading account set for ${market.toUpperCase()}` };
    const { data: allowed, error: allowErr } = await svc
      .from("broker_accounts")
      .select("role")
      .eq("broker", brokerKey)
      .eq("account_number", account)
      .eq("market", market)
      .maybeSingle();
    if (allowErr) return { ok: false, error: `allowlist read failed: ${allowErr.message}` };
    if (!allowed) return { ok: false, error: `Account ${account} is not an allowlisted ${brokerKey} account for ${market}` };
    if ((allowed as any).role !== "trading") return { ok: false, error: `Account ${account} is view_only — not a permitted order target` };
    return { ok: true, account };
  } catch (e) {
    return { ok: false, error: `account resolution error: ${String(e)}` };
  }
}

export type OrderActor = { kind: "owner" | "autonomous_worker"; runId?: string };

export interface ExecuteOrderInput {
  proposalId: number;
  env: "paper" | "live";
  acceptLowQuality?: boolean;
  acceptPortfolioRisk?: boolean;
  overrideReason?: string;
  // Autonomous path supplies its own daily caps (live_auto_daily_cap_usd for US,
  // max_daily_notional_inr for India; live_auto_max_orders_per_day). When set they
  // override the manual strategy_config daily caps in the atomic reservation.
  dailyNotionalCap?: number | null;
  maxDailyTrades?: number | null;
}

export type ExecuteOrderResult =
  | { ok: true; order_id: number; broker_order_id: any }
  | { ok: false; status: number; error: string; needs_reconcile?: boolean; order_id?: number; broker_order_id?: any };

// Runs the full submit-time gate and, on success, submits the broker order and
// records it. `actor` distinguishes the owner (may supply audited risk
// overrides) from the autonomous worker (may NOT override any gate).
export async function executeApprovedOrder(supabase: any, input: ExecuteOrderInput, actor: OrderActor): Promise<ExecuteOrderResult> {
  const proposal_id = input.proposalId;
  const orderEnv: "paper" | "live" = input.env;
  const isOwner = actor.kind === "owner";
  // Only the owner may pass risk overrides. The autonomous worker may never
  // bypass the quality/portfolio gates.
  if (!isOwner && (input.acceptLowQuality || input.acceptPortfolioRisk)) {
    return { ok: false, status: 403, error: "autonomous actor may not override risk gates (acceptLowQuality/acceptPortfolioRisk)" };
  }
  const acceptLowQuality = isOwner ? input.acceptLowQuality : false;
  const acceptPortfolioRisk = isOwner ? input.acceptPortfolioRisk : false;
  const overrideReason = input.overrideReason;

  const { data: proposal } = await supabase.from("trade_proposals").select("*").eq("id", proposal_id).maybeSingle();
  if (!proposal) return { ok: false, status: 404, error: "Proposal not found" };
  if (isOwner) {
    if ((proposal as any).status !== "approved") {
      return { ok: false, status: 400, error: `Proposal status is '${(proposal as any).status}', must be 'approved'` };
    }
    if ((proposal as any).approval_expires_at && new Date((proposal as any).approval_expires_at) < new Date()) {
      return { ok: false, status: 400, error: "Proposal approval has expired" };
    }
  } else {
    // Autonomous worker: authorization is the deployment flag + DB toggle + lease
    // + kernel + kill-switch + session gates enforced upstream (runAutonomousLive),
    // NOT an owner click. Only require this be an autonomous_live proposal.
    if ((proposal as any).execution_mode !== "autonomous_live") {
      return { ok: false, status: 400, error: "autonomous actor may only execute autonomous_live proposals" };
    }
  }

  // Idempotency: refuse a duplicate active order for the same proposal.
  const { data: activeOrder } = await supabase.from("broker_orders").select("id, status")
    .eq("proposal_id", proposal_id).in("status", ["pending_submit", "submitted", "partially_filled", "unknown_needs_reconcile"]).maybeSingle();
  if (activeOrder) return { ok: false, status: 409, error: `An active/unreconciled order already exists for this proposal (id ${(activeOrder as any).id}, status ${(activeOrder as any).status})` };

  const symbol = String((proposal as any).symbol ?? "").toUpperCase();
  const side = (proposal as any).side === "sell" ? "sell" : "buy";
  const qty = Number((proposal as any).qty);
  const market: "us" | "india" = isIndia(symbol) ? "india" : "us";

  // Audit any risk override BEFORE it can bypass the G1/G3 gate (owner only).
  if (orderEnv === "live" && side === "buy" && (acceptLowQuality || acceptPortfolioRisk)) {
    if (!overrideReason || !String(overrideReason).trim()) {
      return { ok: false, status: 400, error: "acceptLowQuality / acceptPortfolioRisk require a non-empty overrideReason (audited)." };
    }
    const { error: auditErr } = await supabase.from("decision_journal").insert({
      entry_type: "risk_override", symbol, market,
      summary: `Live BUY risk override (${[acceptLowQuality && "low-quality-signal", acceptPortfolioRisk && "portfolio-risk"].filter(Boolean).join(", ")}): proposal ${proposal_id} — ${String(overrideReason).slice(0, 300)}`,
      calculations: { proposal_id, acceptLowQuality: !!acceptLowQuality, acceptPortfolioRisk: !!acceptPortfolioRisk },
      has_verified_facts: false, resolved: false,
    });
    if (auditErr) {
      return { ok: false, status: 500, error: `Risk override could not be audited (${auditErr.message}) — aborting live order (fail-closed).` };
    }
  }

  // Basic shape validation regardless of env.
  if (!SYMBOL_RE.test(symbol)) return { ok: false, status: 400, error: `Invalid symbol '${symbol}'` };
  if (!Number.isFinite(qty) || qty <= 0 || !Number.isInteger(qty)) {
    return { ok: false, status: 400, error: `Invalid qty '${(proposal as any).qty}' — must be a positive integer` };
  }

  // Tradable-universe policy (fail-closed): refuse a BUY of a leveraged/inverse
  // ETF or an owner-blocklisted symbol. A SELL is always allowed (must be able to
  // exit a position even if the name was later blocked).
  if (side === "buy") {
    const pol = await isSymbolBlocked(supabase, symbol, market, { failClosed: true });
    if (pol.blocked) return { ok: false, status: 403, error: `Refusing BUY of ${symbol}: ${pol.reason}` };
  }

  // ETF allocation cap — soft guardrail (fail-open): refuse a BUY if current ETF
  // allocation + this order would exceed etf_allocation_cap_pct of portfolio NAV.
  // India market: skip (isEtfSymbol is US-only). SELL always allowed.
  // ponytail: fail-open on any DB error — cap check is advisory, not safety-critical
  if (side === "buy" && market === "us" && isEtfSymbol(symbol)) {
    try {
      const { data: capCfg, error: capError } = await supabase.from("strategy_config")
        .select("etf_allocation_cap_pct").limit(1).maybeSingle();
      if (capError) return { ok: false, status: 503, error: `ETF allocation cap configuration unavailable: ${capError.message}` };
      const cap = capCfg?.etf_allocation_cap_pct != null ? Number(capCfg.etf_allocation_cap_pct) : 30;
      if (!Number.isFinite(cap) || cap < 0 || cap > 100) {
        return { ok: false, status: 503, error: "ETF allocation cap configuration is invalid" };
      }
        let nav: number | null = null;
        let positions: any[] = [];
        if (orderEnv === "paper") {
          const [portRes, posRes] = await Promise.all([
            supabase.from("paper_portfolio").select("nav").eq("market", market).maybeSingle(),
            supabase.from("paper_positions").select("symbol, qty, current_price, updated_at").eq("market", market),
          ]);
          if (portRes.error || posRes.error) return { ok: false, status: 503, error: "ETF allocation inputs are unavailable" };
          const stale = (posRes.data ?? []).some((p: any) => !p.updated_at || Date.now() - Date.parse(p.updated_at) > PAPER_POSITION_PRICE_MAX_AGE_MS);
          if (stale) return { ok: false, status: 503, error: "ETF allocation inputs are stale; refresh paper prices before buying" };
          nav = portRes.data?.nav != null ? Number(portRes.data.nav) : null;
          positions = posRes.data ?? [];
        } else {
          const { data: snap, error: snapError } = await supabase.from("live_account_snapshots")
            .select("equity, positions_json, captured_at").order("captured_at", { ascending: false }).limit(1).maybeSingle();
          if (snapError || !snap?.captured_at || Date.now() - Date.parse(snap.captured_at) > LIVE_SNAPSHOT_MAX_AGE_MS) {
            return { ok: false, status: 503, error: "ETF allocation inputs are stale; refresh the live account before buying" };
          }
          nav = snap?.equity != null ? Number(snap.equity) : null;
          positions = Array.isArray(snap?.positions_json) ? snap.positions_json : [];
        }
        if (!Number.isFinite(nav) || (nav as number) <= 0) return { ok: false, status: 503, error: "ETF allocation NAV is unavailable" };
        const currentFundValue = await fundValueFromPositions(supabase, positions);
        if (!currentFundValue.ok) return { ok: false, status: 503, error: `ETF allocation check: ${currentFundValue.error}` };
          const approxPrice = Number((proposal as any).price_at_proposal ?? (proposal as any).limit_price ?? 0);
        if (!Number.isFinite(approxPrice) || approxPrice <= 0) return { ok: false, status: 503, error: "ETF allocation order price is unavailable" };
          const orderNotional = qty * approxPrice;
          const currentEtfPct = (currentFundValue.value / (nav as number)) * 100;
          const projectedPct = currentEtfPct + (orderNotional / (nav as number)) * 100;
          if (projectedPct > cap) {
            return { ok: false, status: 403, error: `ETF allocation cap: would exceed ${cap}% of portfolio NAV (currently at ${currentEtfPct.toFixed(1)}%, this order would bring it to ${projectedPct.toFixed(1)}%)` };
          }
    } catch (e) {
      return { ok: false, status: 503, error: `ETF allocation check failed: ${String(e)}` };
    }
  }

  // STRICT broker resolution — never falls back to a default broker on a config read error.
  const brokerRes = await getActiveBrokerForOrder(supabase, market);
  if (!brokerRes.ok) return { ok: false, status: 403, error: brokerRes.error };
  const broker = brokerRes.broker;
  const brokerKey = allowlistBrokerKey(broker.id);

  let freshPrice: number | null = null;
  let cfg: any = null;
  if (orderEnv === "live") {
    const cfgRes = await supabase.from("strategy_config").select("trading_enabled, trading_enabled_us, trading_enabled_india, max_order_notional, max_order_notional_usd, max_order_notional_inr, max_daily_notional_usd, max_daily_notional_inr, max_daily_trades, robinhood_mcp_enabled, autonomy_level").limit(1).maybeSingle();
    cfg = cfgRes.data;

    if (!liveOrdersAllowed((cfg as any)?.autonomy_level)) {
      return { ok: false, status: 403, error: `Live orders blocked by autonomy level '${(cfg as any)?.autonomy_level ?? "unset"}' — live requires L3_live_manual or higher (raise it in Settings → Agents).` };
    }
    // Autonomous worker requires L4_live_small_auto or higher.
    // L3_live_manual permits owner clicks only — the autonomous path must be
    // explicitly unlocked at L4. Unknown/null levels fail closed to L3.
    if (!isOwner && !autonomousWorkerAllowed((cfg as any)?.autonomy_level)) {
      return { ok: false, status: 403, error: `Autonomous orders require autonomy_level L4_live_small_auto or higher (current: '${(cfg as any)?.autonomy_level ?? "unset"}') — raise it in Settings → Agents.` };
    }

    const marketFlag = market === "india" ? (cfg as any)?.trading_enabled_india : (cfg as any)?.trading_enabled_us;
    if (!(await isTradingEnabled(supabase, market))) {
      return { ok: false, status: 403, error: "Live trading is disabled (global master or per-market control)" };
    }
    if (marketFlag === false) {
      return { ok: false, status: 403, error: `Live trading is disabled for ${market.toUpperCase()} (view-only mode — turn it back on in Settings → Agents)` };
    }

    if ((broker.id === "robinhood_mcp" || broker.id === "robinhood") && (cfg as any)?.robinhood_mcp_enabled !== true) {
      return { ok: false, status: 403, error: "Robinhood live is disabled (enable it in Settings → Agents before placing live orders)" };
    }

    // G1: signal data-quality gate for live BUY.
    if (side === "buy" && !acceptLowQuality) {
      const sigId = (proposal as any).signal_id;
      const { data: dq } = sigId ? await supabase.from("v_decision_quality")
        .select("data_confidence, quality_status, missing_dims, degraded_dims")
        .eq("signal_id", sigId).order("ts", { ascending: false }).limit(1).maybeSingle() : { data: null };
      const conf = dq ? Number((dq as any).data_confidence) : null;
      const okQuality = !!dq && (dq as any).quality_status === "ok" && Number.isFinite(conf as number) && (conf as number) >= 0.5;
      if (!okQuality) {
        const gaps = dq ? [...((dq as any).missing_dims ?? []), ...((dq as any).degraded_dims ?? [])].join(", ") : "";
        return { ok: false, status: 409, error: `Refusing live BUY of ${symbol}: signal data confidence ${dq ? (conf ?? "unknown") : "unknown (no linked quality record)"} below the 0.5 threshold${gaps ? ` (missing/degraded: ${gaps})` : ""}. Re-approve with acceptLowQuality:true only if you accept the low-evidence signal.` };
      }
    }

    // Account must be an allowlisted role='trading' account for THIS broker (fail closed).
    const acct = await resolveTradingAccount(supabase, market, brokerKey);
    if (!acct.ok) return { ok: false, status: 403, error: acct.error };

    // Kill switch AFTER account resolution so it measures THIS live account's own
    // NAV (P0-1). Side-aware: a trip blocks BUY (new exposure) but not a
    // risk-reducing SELL, which is still gated on fresh held-qty verification.
    const ks = await checkKillSwitches(supabase, { market, book: "live", accountId: acct.account });
    const ksBlocks = side === "sell" ? !ks.sellAllowed : !ks.safe;
    if (ksBlocks) return { ok: false, status: 403, error: `Kill switch active: ${ks.reason}` };

    // Fresh quote → notional cap + price-drift re-check.
    try {
      if (market === "india") { const q = await fetchIndiaQuote(symbol); freshPrice = q?.price ?? null; }
      else { const q = await getQuote(symbol, supabase); freshPrice = q?.price ?? null; }
    } catch { freshPrice = null; }
    if (!freshPrice || !Number.isFinite(freshPrice) || freshPrice <= 0) {
      return { ok: false, status: 502, error: "Could not fetch a fresh quote to validate the order — refusing to submit blind" };
    }

    // Per-market notional cap. FAIL CLOSED.
    let notionalCap: number | null = null;
    if (market === "india") {
      const inr = (cfg as any)?.max_order_notional_inr;
      notionalCap = inr != null ? Number(inr) : null;
    } else {
      const usd = (cfg as any)?.max_order_notional_usd ?? (cfg as any)?.max_order_notional;
      notionalCap = usd != null ? Number(usd) : null;
      if (notionalCap == null) {
        const { data: snap } = await supabase.from("live_account_snapshots").select("equity, captured_at")
          .eq("account_id", acct.account)
          .order("captured_at", { ascending: false }).limit(1).maybeSingle();
        const equity = Number((snap as any)?.equity);
        const capturedAt = (snap as any)?.captured_at ? Date.parse((snap as any).captured_at) : NaN;
        const snapFresh = Number.isFinite(capturedAt) && (Date.now() - capturedAt) <= 30 * 60 * 1000;
        if (snapFresh && Number.isFinite(equity) && equity > 0) notionalCap = equity * DEFAULT_NOTIONAL_FRAC;
      }
    }
    if (side === "buy" && (notionalCap == null || !Number.isFinite(notionalCap) || notionalCap <= 0)) {
      return { ok: false, status: 403, error: market === "india"
        ? "No India (INR) per-order cap set — refusing an uncapped live India order. Set the India cap in Settings → Live Order Limits."
        : "Cannot determine a USD notional cap (no max_order_notional_usd and no live equity snapshot) — refusing an uncapped live order. Set the US cap in Settings → Live Order Limits." };
    }
    if (side === "buy" && Number.isFinite(notionalCap as number) && qty * freshPrice > (notionalCap as number)) {
      const cur = market === "india" ? "₹" : "$";
      return { ok: false, status: 403, error: `Order notional ${cur}${(qty * freshPrice).toFixed(0)} exceeds the ${market.toUpperCase()} cap ${cur}${(notionalCap as number).toFixed(0)}` };
    }

    // G3: live portfolio-construction limits.
    if (side === "buy" && !acceptPortfolioRisk) {
      const pg = await checkLivePortfolioLimits({ supabase, market, accountId: acct.account, symbol, orderNotional: qty * freshPrice });
      if (!pg.ok || pg.skipped) {
        const why = pg.skipped ? `portfolio risk could not be evaluated (${pg.reason})` : pg.reason;
        return { ok: false, status: 409, error: `Refusing live BUY of ${symbol}: ${why}. Re-approve with acceptPortfolioRisk:true to override.` };
      }
    }

    // Price drift vs the approved price.
    const approvedPrice = Number((proposal as any).price_at_proposal ?? (proposal as any).limit_price);
    if (Number.isFinite(approvedPrice) && approvedPrice > 0) {
      const drift = Math.abs(freshPrice - approvedPrice) / approvedPrice;
      if (drift > MAX_PRICE_DRIFT) {
        return { ok: false, status: 409, error: `Price drifted ${(drift * 100).toFixed(1)}% since approval (approved ${approvedPrice}, now ${freshPrice}) — re-approve required` };
      }
    }

    // Long-only for NEW positions: a SELL is only allowed on a currently-held symbol.
    if (side === "sell") {
      if (broker.id === "robinhood_mcp") {
        const heldRes = await robinhoodHeldQty(symbol, acct.account);
        if (!heldRes.ok) return { ok: false, status: 403, error: `Refusing SELL of ${symbol}: could not verify live holdings (${heldRes.error})` };
        if ((heldRes.qty ?? 0) < qty) return { ok: false, status: 403, error: `Refusing SELL of ${qty} ${symbol}: only ${heldRes.qty ?? 0} held on the live trading account` };
      } else if (broker.id === "kite") {
        // Kite holdings are live from the broker (not the snapshot table).
        const holdings = await getKiteHoldings(supabase);
        if (!holdings.ok || !Array.isArray((holdings as any).data)) {
          return { ok: false, status: 403, error: `Refusing SELL of ${symbol}: could not verify Kite holdings (${(holdings as any).error ?? "no data"})` };
        }
        const bare = symbol.replace(/\.(NS|BO)$/i, "").toUpperCase();
        const h = ((holdings as any).data as any[]).find((x) => String(x?.tradingsymbol ?? "").toUpperCase() === bare);
        const heldQty = Number(h?.quantity ?? 0);
        if (heldQty < qty) return { ok: false, status: 403, error: `Refusing SELL of ${qty} ${symbol}: only ${heldQty} held in the Kite account` };
      } else {
        const { data: snap } = await supabase.from("live_account_snapshots")
          .select("positions_json, captured_at")
          .eq("account_id", acct.account)
          .order("captured_at", { ascending: false }).limit(1).maybeSingle();
        const capturedAt = (snap as any)?.captured_at ? Date.parse((snap as any).captured_at) : NaN;
        const fresh = Number.isFinite(capturedAt) && (Date.now() - capturedAt) <= 30 * 60 * 1000;
        if (!snap || !fresh) {
          return { ok: false, status: 403, error: `Refusing SELL of ${symbol}: no fresh (<30 min) holdings snapshot for the trading account — refresh the live account snapshot before selling` };
        }
        const positions: any[] = (snap as any)?.positions_json ?? [];
        const held = Array.isArray(positions) && positions.some(p => String(p?.symbol ?? p?.ticker ?? "").toUpperCase() === symbol && Number(p?.qty ?? p?.quantity ?? 0) >= qty);
        if (!held) return { ok: false, status: 403, error: `Refusing SELL of ${symbol}: not confirmed held in this account's fresh snapshot (long-only for new positions)` };
      }
    }
  }

  // Env / broker compatibility.
  if (!broker.envs.includes(orderEnv)) {
    return { ok: false, status: 400, error: `${broker.id} does not support ${orderEnv} orders` };
  }
  if (!(await broker.isConfigured())) {
    return { ok: false, status: 400, error: `${broker.id} has no API keys configured — add them in Admin → Vault` };
  }

  // Rate limit — rolling 10-minute window across all proposals.
  const ORDER_RATE_LIMIT = Number(process.env.ORDER_RATE_LIMIT_10MIN ?? 12);
  const { count: recentOrders } = await supabase
    .from("broker_orders")
    .select("id", { count: "exact", head: true })
    .gte("created_at", new Date(Date.now() - 10 * 60 * 1000).toISOString());
  if ((recentOrders ?? 0) >= ORDER_RATE_LIMIT) {
    return { ok: false, status: 429, error: `Order rate limit reached (${recentOrders}/${ORDER_RATE_LIMIT} in the last 10 min). Try again shortly.` };
  }

  // Atomic daily-budget reservation + durable pending row. Unified on v2 with an
  // explicit actor: owner → approved_by_user=true (identical to the prior v1
  // behavior for the manual path); autonomous_worker → approved_by_user=false.
  const isIndiaMkt = market === "india";
  const estNotional = (orderEnv === "live" && typeof freshPrice === "number") ? qty * freshPrice : null;
  const { data: reservedId, error: resErr } = await supabase.rpc("reserve_live_order_budget_v2", {
    p_proposal_id: proposal_id, p_market: market, p_broker: broker.id, p_broker_env: orderEnv,
    p_symbol: symbol, p_side: side, p_qty: qty, p_order_type: "market", p_limit_price: null,
    p_estimated_notional: estNotional, p_currency: isIndiaMkt ? "INR" : "USD",
    p_max_daily_trades: input.maxDailyTrades !== undefined ? input.maxDailyTrades : ((cfg as any)?.max_daily_trades ?? null),
    p_max_daily_notional: input.dailyNotionalCap !== undefined ? input.dailyNotionalCap : (isIndiaMkt ? ((cfg as any)?.max_daily_notional_inr ?? null) : ((cfg as any)?.max_daily_notional_usd ?? null)),
    p_execution_actor: actor.kind,
  });
  if (resErr) {
    const m = resErr.message || "";
    if (m.includes("daily_trade_limit")) return { ok: false, status: 429, error: `Daily live-order limit reached — ${m}` };
    if (m.includes("daily_notional_limit")) return { ok: false, status: 403, error: `Daily notional cap reached — ${m}` };
    if ((resErr as any).code === "23505" || m.toLowerCase().includes("duplicate")) return { ok: false, status: 409, error: `Could not open order row (possible duplicate submit): ${m}` };
    return { ok: false, status: 500, error: `Could not reserve order budget: ${m}` };
  }
  const orderId = reservedId as unknown as number;

  const result = await broker.submitOrder({ symbol, side, qty, env: orderEnv });
  if (!result.ok) {
    if (result.needsReconcile) {
      await supabase.from("broker_orders").update({ status: "unknown_needs_reconcile", error: result.error, raw_last_state: result.raw ?? null }).eq("id", orderId);
      await reportIssue({
        issueKey: `order-needs-reconcile:${orderId}`,
        severity: "critical", category: "trading",
        title: `Order #${orderId} needs reconciliation (${side} ${qty} ${symbol})`,
        detail: `A live ${broker.id} order may have been placed but its id couldn't be confirmed: ${result.error}. Check the broker and reconcile broker_orders #${orderId} before re-submitting proposal ${proposal_id}.`,
      }, supabase);
      return { ok: false, status: 202, error: result.error ?? "broker submit ambiguous — needs reconcile", needs_reconcile: true };
    }
    await supabase.from("broker_orders").update({ status: "error", error: result.error }).eq("id", orderId);
    return { ok: false, status: 502, error: result.error ?? "broker submit failed" };
  }

  // ── Durable broker acknowledgment (P0-3) ──────────────────────────────────
  // The order IS now placed at the broker. broker_orders is the source of truth,
  // so the ACK (broker_order_id + raw status) MUST persist. Bounded DB-only retry
  // — NEVER resubmit to the broker. If it still fails we cannot claim success:
  // the order is live but unrecorded, so emit a CRITICAL alert carrying the known
  // broker id and return 202 needs_reconcile so it is recovered, never silently
  // lost or double-submitted on a retry.
  const ackPayload = {
    status: "submitted",
    broker_order_id: result.brokerOrderId,
    submitted_at: new Date().toISOString(),
    raw_last_state: result.raw,
  };
  let ackErr: any = null;
  for (let attempt = 1; attempt <= 3; attempt++) {
    const { error } = await supabase.from("broker_orders").update(ackPayload).eq("id", orderId);
    if (!error) { ackErr = null; break; }
    ackErr = error;
  }
  if (ackErr) {
    await reportIssue({
      issueKey: `order-ack-persist-failed:${orderId}`,
      severity: "critical", category: "trading",
      title: `Order #${orderId} placed at ${broker.id} but ACK not persisted (${side} ${qty} ${symbol})`,
      detail: `The broker ACCEPTED a live ${broker.id} order (broker_order_id ${result.brokerOrderId}) but broker_orders #${orderId} could not be updated to 'submitted' after 3 attempts: ${ackErr.message ?? ackErr}. The order is LIVE at the broker. Reconcile broker_orders #${orderId} → broker_order_id ${result.brokerOrderId} before any resubmit — do NOT re-place proposal ${proposal_id}.`,
    }, supabase);
    return {
      ok: false, status: 202,
      error: `Order placed at ${broker.id} (broker id ${result.brokerOrderId}) but acknowledgment could not be persisted after 3 attempts — needs reconcile, do NOT resubmit`,
      needs_reconcile: true, order_id: orderId, broker_order_id: result.brokerOrderId,
    };
  }

  // Secondary audit journal — best-effort. Its failure does NOT un-place the order
  // (the durable ACK above already recorded it), but surface it so the audit gap
  // is visible rather than silently swallowed.
  const { error: journalErr } = await supabase.from("decision_journal").insert({
    entry_type: "broker_order", symbol, market,
    summary: `${broker.id} ${orderEnv.toUpperCase()} order: ${side} ${qty} × ${symbol} (proposal ${proposal_id}) → order ${result.brokerOrderId}`,
    calculations: { proposal_id, broker: broker.id, env: orderEnv, side, qty, broker_order_id: result.brokerOrderId, actor: actor.kind, auto_run_id: actor.runId ?? null },
    has_verified_facts: true, resolved: false,
  });
  if (journalErr) {
    await reportIssue({
      issueKey: `order-journal-failed:${orderId}`,
      severity: "warn", category: "trading",
      title: `Order #${orderId} recorded but audit journal write failed`,
      detail: `broker_orders #${orderId} (broker_order_id ${result.brokerOrderId}) is durably recorded, but the decision_journal audit entry failed to insert: ${journalErr.message ?? journalErr}. The order state is correct; only the audit log is missing.`,
    }, supabase);
  }

  return { ok: true, order_id: orderId, broker_order_id: result.brokerOrderId };
}
