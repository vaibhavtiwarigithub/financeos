import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/service";
import { getActiveBroker } from "@/lib/brokers/registry";
import { isIndia, fetchIndiaQuote } from "@/lib/india-data";
import { requireOwner } from "@/lib/auth/require-owner";
import { guardOrderRequest } from "@/lib/request-guards";
import { checkKillSwitches } from "@/lib/kill-switches";
import { getQuote } from "@/lib/data/quotes";

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
async function resolveTradingAccount(svc: any, market: "us" | "india"): Promise<{ ok: true; account: string } | { ok: false; error: string }> {
  try {
    const col = market === "india" ? "active_account_india" : "active_account_us";
    const { data: cfg, error: cfgErr } = await svc.from("strategy_config").select(col).limit(1).maybeSingle();
    if (cfgErr) return { ok: false, error: `account config read failed: ${cfgErr.message}` };
    const account = (cfg as any)?.[col];
    if (!account) return { ok: false, error: `No active trading account set for ${market.toUpperCase()}` };
    const { data: allowed, error: allowErr } = await svc
      .from("broker_accounts")
      .select("role")
      .eq("account_number", account)
      .eq("market", market)
      .maybeSingle();
    if (allowErr) return { ok: false, error: `allowlist read failed: ${allowErr.message}` };
    if (!allowed) return { ok: false, error: `Account ${account} is not in the broker_accounts allowlist` };
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
    const { proposal_id, env } = body as { proposal_id?: number; env?: "paper" | "live" };
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
    const { data: activeOrder } = await supabase.from("broker_orders").select("id")
      .eq("proposal_id", proposal_id).in("status", ["pending_submit", "submitted", "partially_filled"]).maybeSingle();
    if (activeOrder) return NextResponse.json({ error: `An active order already exists for this proposal (id ${(activeOrder as any).id})` }, { status: 409 });

    const symbol = String((proposal as any).symbol ?? "").toUpperCase();
    const side = (proposal as any).side === "sell" ? "sell" : "buy";
    const qty = Number((proposal as any).qty);
    const market: "us" | "india" = isIndia(symbol) ? "india" : "us";

    // Basic shape validation regardless of env.
    if (!SYMBOL_RE.test(symbol)) return NextResponse.json({ error: `Invalid symbol '${symbol}'` }, { status: 400 });
    if (!Number.isFinite(qty) || qty <= 0 || !Number.isInteger(qty)) {
      return NextResponse.json({ error: `Invalid qty '${(proposal as any).qty}' — must be a positive integer` }, { status: 400 });
    }

    if (orderEnv === "live") {
      const { data: cfg } = await supabase.from("strategy_config").select("trading_enabled, trading_enabled_us, trading_enabled_india, max_order_notional").limit(1).maybeSingle();
      const marketFlag = market === "india" ? (cfg as any)?.trading_enabled_india : (cfg as any)?.trading_enabled_us;
      if (!(cfg as any)?.trading_enabled) {
        return NextResponse.json({ error: "Live trading is disabled (strategy_config.trading_enabled = false)" }, { status: 403 });
      }
      if (marketFlag === false) {
        return NextResponse.json({ error: `Live trading is disabled for ${market.toUpperCase()} (view-only mode — turn it back on in Settings → Agents)` }, { status: 403 });
      }

      // Kill switches run at proposal build/approve; run them again at submit —
      // conditions (daily loss, drawdown, accuracy) can trip between approval
      // and the human clicking Send.
      const ks = await checkKillSwitches(supabase, market);
      if (!ks.safe) return NextResponse.json({ error: `Kill switch active: ${ks.reason}` }, { status: 403 });

      // Account must be an allowlisted role='trading' account (fail closed).
      const acct = await resolveTradingAccount(supabase, market);
      if (!acct.ok) return NextResponse.json({ error: acct.error }, { status: 403 });

      // Fresh quote → notional cap + price-drift re-check.
      let freshPrice: number | null = null;
      try {
        if (market === "india") { const q = await fetchIndiaQuote(symbol); freshPrice = q?.price ?? null; }
        else { const q = await getQuote(symbol, supabase); freshPrice = q?.price ?? null; }
      } catch { freshPrice = null; }
      if (!freshPrice || !Number.isFinite(freshPrice) || freshPrice <= 0) {
        return NextResponse.json({ error: "Could not fetch a fresh quote to validate the order — refusing to submit blind" }, { status: 502 });
      }

      // Notional cap: explicit config value, else a fraction of live equity.
      // FAIL CLOSED — if we can't determine a cap for a live order (no config
      // value AND no equity snapshot), refuse rather than send an uncapped
      // real-money order.
      let notionalCap = (cfg as any)?.max_order_notional != null ? Number((cfg as any).max_order_notional) : null;
      if (notionalCap == null) {
        const { data: snap } = await supabase.from("live_account_snapshots").select("equity").order("captured_at", { ascending: false }).limit(1).maybeSingle();
        const equity = Number((snap as any)?.equity);
        if (Number.isFinite(equity) && equity > 0) notionalCap = equity * DEFAULT_NOTIONAL_FRAC;
      }
      if (notionalCap == null || !Number.isFinite(notionalCap) || notionalCap <= 0) {
        return NextResponse.json({ error: "Cannot determine a notional cap (no max_order_notional set and no live equity snapshot) — refusing an uncapped live order. Set strategy_config.max_order_notional or refresh the account snapshot." }, { status: 403 });
      }
      if (qty * freshPrice > notionalCap) {
        return NextResponse.json({ error: `Order notional ${(qty * freshPrice).toFixed(0)} exceeds the cap ${notionalCap.toFixed(0)}` }, { status: 403 });
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
      // symbol (CLAUDE.md locked rule). Check the latest live snapshot.
      if (side === "sell") {
        const { data: snap } = await supabase.from("live_account_snapshots").select("positions_json").order("captured_at", { ascending: false }).limit(1).maybeSingle();
        const positions: any[] = (snap as any)?.positions_json ?? [];
        const held = Array.isArray(positions) && positions.some(p => String(p?.symbol ?? p?.ticker ?? "").toUpperCase() === symbol && Number(p?.qty ?? p?.quantity ?? 0) > 0);
        if (!held) return NextResponse.json({ error: `Refusing SELL of ${symbol}: not found in current holdings (long-only for new positions)` }, { status: 403 });
      }
    }

    const broker = await getActiveBroker(supabase, market);
    // Both directions: a live-only broker rejects paper; a paper-only broker
    // rejects live. Prevents a mis-typed/missing env from routing to the wrong
    // environment past the gates above.
    if (!broker.envs.includes(orderEnv)) {
      return NextResponse.json({ error: `${broker.id} does not support ${orderEnv} orders` }, { status: 400 });
    }
    if (!(await broker.isConfigured())) {
      return NextResponse.json({ error: `${broker.id} has no API keys configured — add them in Admin → Vault` }, { status: 400 });
    }

    const { data: orderRow, error: insErr } = await supabase.from("broker_orders").insert({
      proposal_id, market, broker: broker.id, broker_env: orderEnv,
      symbol, side, qty, order_type: "market", status: "pending_submit", approved_by_user: true,
    }).select("id").single();
    // The partial unique index (migration 094) makes a concurrent double-click
    // fail here instead of double-submitting.
    if (insErr) return NextResponse.json({ error: `Could not open order row (possible duplicate submit): ${insErr.message}` }, { status: 409 });
    const orderId = (orderRow as any)?.id;

    const result = await broker.submitOrder({ symbol, side, qty, env: orderEnv });
    if (!result.ok) {
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
