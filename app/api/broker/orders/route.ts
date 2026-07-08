import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/service";
import { getActiveBrokerForOrder } from "@/lib/brokers/registry";
import { isIndia, fetchIndiaQuote } from "@/lib/india-data";
import { requireOwner } from "@/lib/auth/require-owner";
import { guardOrderRequest } from "@/lib/request-guards";
import { checkKillSwitches } from "@/lib/kill-switches";
import { checkLivePortfolioLimits } from "@/lib/risk/live-portfolio-gate";
import { getQuote } from "@/lib/data/quotes";
import { robinhoodHeldQty } from "@/lib/robinhood-mcp";
import { reportIssue } from "@/lib/system-health";

// Adapter id → the brokerage key used in the broker_accounts allowlist.
function allowlistBrokerKey(brokerId: string): string {
  return brokerId === "robinhood_mcp" ? "robinhood" : brokerId;
}

export const dynamic = "force-dynamic";

// Fraction of live equity used as the default per-order notional ceiling when
// strategy_config.max_order_notional is null.
const DEFAULT_NOTIONAL_FRAC = 0.15;
// Reject a live order if the fresh quote has drifted more than this from the
// price the proposal was approved at (matches trader/route.ts's approval gate).
const MAX_PRICE_DRIFT = 0.03;
const SYMBOL_RE = /^[A-Z.\-]{1,10}$/;

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

// Execution Gateway (spec Part A). NEVER cron-callable — every order requires a
// logged-in OWNER human click. Live orders pass a full submit-time gate:
// kill switches, env validation, notional cap, price-drift re-check, and
// sell-only-if-held, on top of the trading_enabled flags.
export async function POST(req: NextRequest) {
  // Owner-only + CSRF/DNS-rebinding guard (this places real orders).
  const ownerGate = await requireOwner();
  if (ownerGate) return ownerGate;
  const guardErr = guardOrderRequest(req);
  if (guardErr) return guardErr;

  try {
    const body = await req.json();
    const { proposal_id, env, acceptLowQuality, acceptPortfolioRisk } = body as { proposal_id?: number; env?: "paper" | "live"; acceptLowQuality?: boolean; acceptPortfolioRisk?: boolean };
    // env must be explicit on an order-placing route — no silent paper default
    // that could route a mis-typed request past the live gates.
    if (env !== "paper" && env !== "live") {
      return NextResponse.json({ error: "env must be explicitly 'paper' or 'live'" }, { status: 400 });
    }
    const orderEnv: "paper" | "live" = env;
    if (!proposal_id) return NextResponse.json({ error: "proposal_id required" }, { status: 400 });

    const supabase = createServiceClient();

    const { data: proposal } = await supabase.from("trade_proposals").select("*").eq("id", proposal_id).maybeSingle();
    if (!proposal) return NextResponse.json({ error: "Proposal not found" }, { status: 404 });
    if ((proposal as any).status !== "approved") {
      return NextResponse.json({ error: `Proposal status is '${(proposal as any).status}', must be 'approved'` }, { status: 400 });
    }
    if ((proposal as any).approval_expires_at && new Date((proposal as any).approval_expires_at) < new Date()) {
      return NextResponse.json({ error: "Proposal approval has expired" }, { status: 400 });
    }

    // Idempotency: refuse a duplicate active order for the same proposal. A
    // partial unique index on broker_orders(proposal_id) WHERE status in
    // (pending_submit,submitted,partially_filled) is the hard backstop against
    // the concurrent-click race (migration 094); this is the friendly check.
    const { data: activeOrder } = await supabase.from("broker_orders").select("id, status")
      .eq("proposal_id", proposal_id).in("status", ["pending_submit", "submitted", "partially_filled", "unknown_needs_reconcile"]).maybeSingle();
    if (activeOrder) return NextResponse.json({ error: `An active/unreconciled order already exists for this proposal (id ${(activeOrder as any).id}, status ${(activeOrder as any).status})` }, { status: 409 });

    const symbol = String((proposal as any).symbol ?? "").toUpperCase();
    const side = (proposal as any).side === "sell" ? "sell" : "buy";
    const qty = Number((proposal as any).qty);
    const market: "us" | "india" = isIndia(symbol) ? "india" : "us";

    // Basic shape validation regardless of env.
    if (!SYMBOL_RE.test(symbol)) return NextResponse.json({ error: `Invalid symbol '${symbol}'` }, { status: 400 });
    if (!Number.isFinite(qty) || qty <= 0 || !Number.isInteger(qty)) {
      return NextResponse.json({ error: `Invalid qty '${(proposal as any).qty}' — must be a positive integer` }, { status: 400 });
    }

    // STRICT broker resolution — never falls back to a default broker on a
    // config read error (that could route a live order to the wrong account).
    const brokerRes = await getActiveBrokerForOrder(supabase, market);
    if (!brokerRes.ok) return NextResponse.json({ error: brokerRes.error }, { status: 403 });
    const broker = brokerRes.broker;
    const brokerKey = allowlistBrokerKey(broker.id);

    // Hoisted to function scope so the post-block budget reservation can read them
    // (freshPrice + daily caps are only populated on the live path).
    let freshPrice: number | null = null;
    let cfg: any = null;
    if (orderEnv === "live") {
      const cfgRes = await supabase.from("strategy_config").select("trading_enabled, trading_enabled_us, trading_enabled_india, max_order_notional, max_order_notional_usd, max_order_notional_inr, max_daily_notional_usd, max_daily_notional_inr, max_daily_trades, robinhood_mcp_enabled").limit(1).maybeSingle();
      cfg = cfgRes.data;
      const marketFlag = market === "india" ? (cfg as any)?.trading_enabled_india : (cfg as any)?.trading_enabled_us;
      if (!(cfg as any)?.trading_enabled) {
        return NextResponse.json({ error: "Live trading is disabled (strategy_config.trading_enabled = false)" }, { status: 403 });
      }
      if (marketFlag === false) {
        return NextResponse.json({ error: `Live trading is disabled for ${market.toUpperCase()} (view-only mode — turn it back on in Settings → Agents)` }, { status: 403 });
      }

      // Robinhood MCP has its own dedicated kill switch (default off) — enforce
      // it on the ORDER path, not only the snapshot path.
      if (broker.id === "robinhood_mcp" && (cfg as any)?.robinhood_mcp_enabled !== true) {
        return NextResponse.json({ error: "Robinhood MCP is disabled (enable it in Settings → Agents before placing live orders)" }, { status: 403 });
      }

      // Kill switches run at proposal build/approve; run them again at submit —
      // conditions (daily loss, drawdown, accuracy) can trip between approval
      // and the human clicking Send.
      const ks = await checkKillSwitches(supabase, market);
      if (!ks.safe) return NextResponse.json({ error: `Kill switch active: ${ks.reason}` }, { status: 403 });

      // G1: signal data-quality gate for live BUY. Block a live BUY whose source
      // decision was low-evidence / tainted (the fake-100 partial-data pattern) so real
      // money isn't sized on a bad thesis. SELL exits are exempt. Owner can override
      // with acceptLowQuality:true (an explicit re-approval of a thin signal).
      if (side === "buy" && !acceptLowQuality) {
        const sigId = (proposal as any).signal_id;
        const { data: dq } = sigId ? await supabase.from("v_decision_quality")
          .select("data_confidence, quality_status, missing_dims, degraded_dims")
          .eq("signal_id", sigId).order("ts", { ascending: false }).limit(1).maybeSingle() : { data: null };
        const conf = dq ? Number((dq as any).data_confidence) : null;
        const okQuality = !!dq && (dq as any).quality_status === "ok" && Number.isFinite(conf as number) && (conf as number) >= 0.5;
        if (!okQuality) {
          const gaps = dq ? [...((dq as any).missing_dims ?? []), ...((dq as any).degraded_dims ?? [])].join(", ") : "";
          return NextResponse.json({ error: `Refusing live BUY of ${symbol}: signal data confidence ${dq ? (conf ?? "unknown") : "unknown (no linked quality record)"} below the 0.5 threshold${gaps ? ` (missing/degraded: ${gaps})` : ""}. Re-approve with acceptLowQuality:true only if you accept the low-evidence signal.` }, { status: 409 });
        }
      }

      // Account must be an allowlisted role='trading' account for THIS broker
      // (fail closed).
      const acct = await resolveTradingAccount(supabase, market, brokerKey);
      if (!acct.ok) return NextResponse.json({ error: acct.error }, { status: 403 });

      // Fresh quote → notional cap + price-drift re-check.
      try {
        if (market === "india") { const q = await fetchIndiaQuote(symbol); freshPrice = q?.price ?? null; }
        else { const q = await getQuote(symbol, supabase); freshPrice = q?.price ?? null; }
      } catch { freshPrice = null; }
      if (!freshPrice || !Number.isFinite(freshPrice) || freshPrice <= 0) {
        return NextResponse.json({ error: "Could not fetch a fresh quote to validate the order — refusing to submit blind" }, { status: 502 });
      }

      // Per-market notional cap. FAIL CLOSED — if we can't determine a cap for a
      // live order, refuse rather than send an uncapped real-money order.
      //   US:    max_order_notional_usd (→ deprecated max_order_notional → % of live
      //          equity from a fresh snapshot). The equity fallback is USD-only.
      //   India: max_order_notional_inr ONLY. No trusted Kite equity fallback exists,
      //          so a null INR cap refuses the order (never falls back to a USD number
      //          or an equity fraction against an INR notional).
      let notionalCap: number | null = null;
      if (market === "india") {
        const inr = (cfg as any)?.max_order_notional_inr;
        notionalCap = inr != null ? Number(inr) : null;
      } else {
        const usd = (cfg as any)?.max_order_notional_usd ?? (cfg as any)?.max_order_notional;
        notionalCap = usd != null ? Number(usd) : null;
        if (notionalCap == null) {
          // Filter by the resolved trading account — prevents the read-only account's
          // larger equity from raising the live order cap for the agentic account.
          const { data: snap } = await supabase.from("live_account_snapshots").select("equity, captured_at")
            .eq("account_id", acct.account)
            .order("captured_at", { ascending: false }).limit(1).maybeSingle();
          const equity = Number((snap as any)?.equity);
          // Freshness bound — a STALE snapshot must not raise the cap (funds may have
          // left since it was captured). If stale/missing, skip the fallback and let
          // the null-cap check below fail closed.
          const capturedAt = (snap as any)?.captured_at ? Date.parse((snap as any).captured_at) : NaN;
          const snapFresh = Number.isFinite(capturedAt) && (Date.now() - capturedAt) <= 30 * 60 * 1000;
          if (snapFresh && Number.isFinite(equity) && equity > 0) notionalCap = equity * DEFAULT_NOTIONAL_FRAC;
        }
      }
      if (notionalCap == null || !Number.isFinite(notionalCap) || notionalCap <= 0) {
        return NextResponse.json({ error: market === "india"
          ? "No India (INR) per-order cap set — refusing an uncapped live India order. Set the India cap in Settings → Live Order Limits."
          : "Cannot determine a USD notional cap (no max_order_notional_usd and no live equity snapshot) — refusing an uncapped live order. Set the US cap in Settings → Live Order Limits." }, { status: 403 });
      }
      if (qty * freshPrice > notionalCap) {
        const cur = market === "india" ? "₹" : "$";
        return NextResponse.json({ error: `Order notional ${cur}${(qty * freshPrice).toFixed(0)} exceeds the ${market.toUpperCase()} cap ${cur}${notionalCap.toFixed(0)}` }, { status: 403 });
      }

      // G3: live portfolio-construction limits (name / gross / sector / vol) vs the live
      // book. Refuses a BUY that would push the book past a limit (require re-approval).
      // US only today (needs a live NAV snapshot); skipped when NAV is stale/absent.
      if (side === "buy" && !acceptPortfolioRisk) {
        const pg = await checkLivePortfolioLimits({ supabase, market, accountId: acct.account, symbol, orderNotional: qty * freshPrice });
        if (!pg.ok) {
          return NextResponse.json({ error: `Refusing live BUY of ${symbol}: ${pg.reason}. Re-approve with acceptPortfolioRisk:true to override.` }, { status: 409 });
        }
      }

      // Price drift vs the approved price.
      const approvedPrice = Number((proposal as any).price_at_proposal ?? (proposal as any).limit_price);
      if (Number.isFinite(approvedPrice) && approvedPrice > 0) {
        const drift = Math.abs(freshPrice - approvedPrice) / approvedPrice;
        if (drift > MAX_PRICE_DRIFT) {
          return NextResponse.json({ error: `Price drifted ${(drift * 100).toFixed(1)}% since approval (approved ${approvedPrice}, now ${freshPrice}) — re-approve required` }, { status: 409 });
        }
      }

      // Long-only for NEW positions: a SELL is only allowed on a currently-held
      // symbol (CLAUDE.md locked rule), verified against the ACTUAL account that
      // will trade — not the cached read-only snapshot (which is a different RH
      // account). For Robinhood MCP, fetch live positions for the active trading
      // account; fail closed if that can't be determined.
      if (side === "sell") {
        if (broker.id === "robinhood_mcp") {
          const heldRes = await robinhoodHeldQty(symbol, acct.account);
          if (!heldRes.ok) return NextResponse.json({ error: `Refusing SELL of ${symbol}: could not verify live holdings (${heldRes.error})` }, { status: 403 });
          if ((heldRes.qty ?? 0) < qty) return NextResponse.json({ error: `Refusing SELL of ${qty} ${symbol}: only ${heldRes.qty ?? 0} held on the live trading account` }, { status: 403 });
        } else {
          // Other brokers: snapshot check scoped to THIS account + freshness bound.
          // FAIL CLOSED — an unfiltered or stale snapshot could authorize a SELL from
          // a different or out-of-date account. Require a snapshot for acct.account
          // captured within 30 min.
          const { data: snap } = await supabase.from("live_account_snapshots")
            .select("positions_json, captured_at")
            .eq("account_id", acct.account)
            .order("captured_at", { ascending: false }).limit(1).maybeSingle();
          const capturedAt = (snap as any)?.captured_at ? Date.parse((snap as any).captured_at) : NaN;
          const fresh = Number.isFinite(capturedAt) && (Date.now() - capturedAt) <= 30 * 60 * 1000;
          if (!snap || !fresh) {
            return NextResponse.json({ error: `Refusing SELL of ${symbol}: no fresh (<30 min) holdings snapshot for the trading account — refresh the live account snapshot before selling` }, { status: 403 });
          }
          const positions: any[] = (snap as any)?.positions_json ?? [];
          const held = Array.isArray(positions) && positions.some(p => String(p?.symbol ?? p?.ticker ?? "").toUpperCase() === symbol && Number(p?.qty ?? p?.quantity ?? 0) >= qty);
          if (!held) return NextResponse.json({ error: `Refusing SELL of ${symbol}: not confirmed held in this account's fresh snapshot (long-only for new positions)` }, { status: 403 });
        }
      }
    }

    // Both directions: a live-only broker rejects paper; a paper-only broker
    // rejects live. Prevents a mis-typed/missing env from routing to the wrong
    // environment past the gates above.
    if (!broker.envs.includes(orderEnv)) {
      return NextResponse.json({ error: `${broker.id} does not support ${orderEnv} orders` }, { status: 400 });
    }
    if (!(await broker.isConfigured())) {
      return NextResponse.json({ error: `${broker.id} has no API keys configured — add them in Admin → Vault` }, { status: 400 });
    }

    // Rate limit — even a stolen owner cookie can't fire an unbounded burst of
    // live orders. Cap orders in a rolling 10-minute window across all proposals.
    const ORDER_RATE_LIMIT = Number(process.env.ORDER_RATE_LIMIT_10MIN ?? 12);
    const { count: recentOrders } = await supabase
      .from("broker_orders")
      .select("id", { count: "exact", head: true })
      .gte("created_at", new Date(Date.now() - 10 * 60 * 1000).toISOString());
    if ((recentOrders ?? 0) >= ORDER_RATE_LIMIT) {
      return NextResponse.json({ error: `Order rate limit reached (${recentOrders}/${ORDER_RATE_LIMIT} in the last 10 min). Try again shortly.` }, { status: 429 });
    }

    // Atomic daily-budget reservation + durable pending row (G4/G5/G6). Under a
    // per-(day,market) advisory lock this serializes concurrent live orders,
    // enforces the per-market daily trade COUNT + cumulative NOTIONAL (BUY only, so
    // exits are never blocked), and inserts the pending broker_orders row. The
    // partial unique dup-submit index (migration 094) still fires inside the RPC on
    // a duplicate proposal. estimated_notional is in the market currency (freshPrice
    // is USD for US, INR for India).
    const isIndiaMkt = market === "india";
    const estNotional = (orderEnv === "live" && typeof freshPrice === "number") ? qty * freshPrice : null;
    const { data: reservedId, error: resErr } = await supabase.rpc("reserve_live_order_budget", {
      p_proposal_id: proposal_id, p_market: market, p_broker: broker.id, p_broker_env: orderEnv,
      p_symbol: symbol, p_side: side, p_qty: qty, p_order_type: "market", p_limit_price: null,
      p_estimated_notional: estNotional, p_currency: isIndiaMkt ? "INR" : "USD",
      p_max_daily_trades: (cfg as any)?.max_daily_trades ?? null,
      p_max_daily_notional: isIndiaMkt ? ((cfg as any)?.max_daily_notional_inr ?? null) : ((cfg as any)?.max_daily_notional_usd ?? null),
    });
    if (resErr) {
      const m = resErr.message || "";
      if (m.includes("daily_trade_limit")) return NextResponse.json({ error: `Daily live-order limit reached — ${m}` }, { status: 429 });
      if (m.includes("daily_notional_limit")) return NextResponse.json({ error: `Daily notional cap reached — ${m}` }, { status: 403 });
      if ((resErr as any).code === "23505" || m.toLowerCase().includes("duplicate")) return NextResponse.json({ error: `Could not open order row (possible duplicate submit): ${m}` }, { status: 409 });
      return NextResponse.json({ error: `Could not reserve order budget: ${m}` }, { status: 500 });
    }
    const orderId = reservedId as unknown as number;

    const result = await broker.submitOrder({ symbol, side, qty, env: orderEnv });
    if (!result.ok) {
      // AMBIGUOUS outcome (possible-success timeout, or success with no order
      // id): mark unknown_needs_reconcile — the dup-submit unique index (mig
      // 095) treats this as an active status, so the proposal can't be
      // resubmitted until reconciled via get_equity_orders.
      if (result.needsReconcile) {
        await supabase.from("broker_orders").update({ status: "unknown_needs_reconcile", error: result.error, raw_last_state: result.raw ?? null }).eq("id", orderId);
        // A real order MAY have been placed at the broker but we can't confirm
        // its id — persist a CRITICAL open issue until a human reconciles it
        // (resolved by the order-sync loop / manual reconcile). Money is at risk.
        await reportIssue({
          issueKey: `order-needs-reconcile:${orderId}`,
          severity: "critical", category: "trading",
          title: `Order #${orderId} needs reconciliation (${side} ${qty} ${symbol})`,
          detail: `A live ${broker.id} order may have been placed but its id couldn't be confirmed: ${result.error}. Check the broker and reconcile broker_orders #${orderId} before re-submitting proposal ${proposal_id}.`,
        }, supabase);
        return NextResponse.json({ error: result.error, needs_reconcile: true }, { status: 202 });
      }
      await supabase.from("broker_orders").update({ status: "error", error: result.error }).eq("id", orderId);
      return NextResponse.json({ error: result.error }, { status: 502 });
    }

    await supabase.from("broker_orders").update({
      status: "submitted", broker_order_id: result.brokerOrderId, submitted_at: new Date().toISOString(), raw_last_state: result.raw,
    }).eq("id", orderId);

    await supabase.from("decision_journal").insert({
      entry_type: "broker_order", symbol, market,
      summary: `${broker.id} ${orderEnv.toUpperCase()} order: ${side} ${qty} × ${symbol} (proposal ${proposal_id}) → order ${result.brokerOrderId}`,
      calculations: { proposal_id, broker: broker.id, env: orderEnv, side, qty, broker_order_id: result.brokerOrderId },
      has_verified_facts: true, resolved: false,
    });

    return NextResponse.json({ success: true, order_id: orderId, broker_order_id: result.brokerOrderId });
  } catch (err: unknown) {
    return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 500 });
  }
}

export async function GET(req: NextRequest) {
  const ownerGate = await requireOwner();
  if (ownerGate) return ownerGate;

  const supabase = createServiceClient();
  const status = new URL(req.url).searchParams.get("status");
  let q = supabase.from("broker_orders").select("*").order("created_at", { ascending: false }).limit(50);
  if (status) q = q.eq("status", status);
  const { data, error } = await q;
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ orders: data ?? [] });
}
