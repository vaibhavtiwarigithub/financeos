-- 152_rpc_grant_and_session_fixes.sql
-- Phase A / P0-5 (07_08_FULL_APP_REVIEW.md): budget-RPC grant + session-date hardening.
--
-- Two defects fixed here, both additive / behavior-tightening only:
--   1. reserve_live_order_budget (v1, 14-arg) is EXECUTE-granted to `anon` and
--      `authenticated`. It is SECURITY DEFINER and inserts a durable pending
--      broker_orders row (a real live-order reservation). Any browser-role JWT
--      could call it directly and reserve budget / seed a live order row.
--      => REVOKE from PUBLIC/anon/authenticated. service_role + postgres keep it
--         (the Kite route still calls v1 via the service client; the US live path
--         uses v2). Do NOT drop v1 — a live caller still depends on it until the
--         Kite path is unified (deferred A2).
--   2. reserve_live_order_budget_v2 computes the daily-budget window with
--      `current_date` and `date_trunc('day', now())` — both in the DB session TZ
--      (UTC on Supabase). The daily live-BUY cap therefore rolls over at UTC
--      midnight, not at the market's local session day. A US order at 20:00 ET
--      (00:00 UTC next day) sees a fresh budget mid-session. => recompute the
--      window in the market-local timezone and widen the advisory lock key to
--      include broker/broker_env so unrelated markets/brokers don't serialize on
--      each other. Also add explicit input validation (market, market/currency
--      pairing, positive finite qty/notional) — the function is definer-run and
--      must fail closed on malformed input.
--
-- Idempotent: REVOKE is safe to re-run; the function body is CREATE OR REPLACE.

begin;

-- ── 1. Revoke browser-role EXECUTE on the legacy v1 reservation RPC ──────────
revoke execute on function public.reserve_live_order_budget(
  bigint, text, text, text, text, text, numeric, text, numeric, numeric,
  text, integer, numeric, text
) from public, anon, authenticated;

-- Defensive: v2 must never be browser-callable either (it currently is not, but
-- pin it so a future CREATE OR REPLACE default-grant to PUBLIC can't reopen it).
revoke execute on function public.reserve_live_order_budget_v2(
  bigint, text, text, text, text, text, numeric, text, numeric, numeric,
  text, integer, numeric, text
) from public, anon, authenticated;

-- ── 2. Market-local session date + hardened v2 ──────────────────────────────
create or replace function public.reserve_live_order_budget_v2(
  p_proposal_id bigint,
  p_market text,
  p_broker text,
  p_broker_env text,
  p_symbol text,
  p_side text,
  p_qty numeric,
  p_order_type text,
  p_limit_price numeric,
  p_estimated_notional numeric,
  p_currency text,
  p_max_daily_trades integer,
  p_max_daily_notional numeric,
  p_execution_actor text
)
returns bigint
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_count int;
  v_sum   numeric;
  v_id    bigint;
  v_approved_by_user boolean;
  v_tz          text;
  v_local_date  date;
  v_day_start   timestamptz;
begin
  -- actor must be explicit; null/unknown fails closed.
  if p_execution_actor not in ('owner', 'autonomous_worker') then
    raise exception 'invalid_execution_actor: must be owner or autonomous_worker'
      using errcode = 'P0001';
  end if;

  -- market → session timezone. Unknown market fails closed (no default day).
  v_tz := case p_market
            when 'us'    then 'America/New_York'
            when 'india' then 'Asia/Kolkata'
            else null
          end;
  if v_tz is null then
    raise exception 'invalid_market: % (expected us|india)', coalesce(p_market, '<null>')
      using errcode = 'P0001';
  end if;

  -- currency must match the market — a mismatched pair means a mis-routed order.
  if not ((p_market = 'us' and p_currency = 'USD')
          or (p_market = 'india' and p_currency = 'INR')) then
    raise exception 'invalid_market_currency: % / %', p_market, coalesce(p_currency, '<null>')
      using errcode = 'P0001';
  end if;

  -- positive, finite quantity (numeric NaN compares equal to NaN in Postgres).
  if p_qty is null or p_qty = 'NaN'::numeric or p_qty <= 0 then
    raise exception 'invalid_qty: must be a positive finite number'
      using errcode = 'P0001';
  end if;

  -- a live BUY reservation must carry a positive finite notional (the cap math
  -- and the notional-limit gate both depend on it).
  if p_side = 'buy' and p_broker_env = 'live'
     and (p_estimated_notional is null
          or p_estimated_notional = 'NaN'::numeric
          or p_estimated_notional <= 0) then
    raise exception 'invalid_notional: live BUY requires a positive finite estimated_notional'
      using errcode = 'P0001';
  end if;

  v_approved_by_user := (p_execution_actor = 'owner');

  -- Market-local session day: local midnight, converted back to a UTC instant
  -- for comparison against broker_orders.created_at (timestamptz).
  v_local_date := (now() at time zone v_tz)::date;
  v_day_start  := (v_local_date::timestamp) at time zone v_tz;

  -- Serialize concurrent live orders for the same market + broker + env + local
  -- session day. Widening the key past market means an India Kite order and a US
  -- Robinhood order don't block on the same lock.
  perform pg_advisory_xact_lock(hashtext(
    v_local_date::text || ':' || coalesce(p_market, '')
      || ':' || coalesce(p_broker, '') || ':' || coalesce(p_broker_env, '')
  ));

  -- Daily caps apply to LIVE BUY orders only. Paper orders and SELL exits exempt.
  if p_side = 'buy' and p_broker_env = 'live' then
    -- Count all active orders (pending_submit, submitted, partially_filled,
    -- unknown_needs_reconcile) so timeouts cannot silently re-open budget.
    select count(*), coalesce(sum(estimated_notional), 0)
      into v_count, v_sum
      from broker_orders
      where market = p_market
        and broker_env = 'live'
        and side = 'buy'
        and created_at >= v_day_start
        and status not in ('error', 'rejected', 'canceled', 'cancelled');

    if p_max_daily_trades is not null and v_count + 1 > p_max_daily_trades then
      raise exception 'daily_trade_limit: % live BUY orders today reaches the daily cap of %',
        v_count, p_max_daily_trades using errcode = 'P0001';
    end if;

    if p_max_daily_notional is not null
       and v_sum + coalesce(p_estimated_notional, 0) > p_max_daily_notional then
      raise exception 'daily_notional_limit: today %/% used, this order % would exceed the daily cap',
        round(v_sum, 2), round(p_max_daily_notional, 2), round(coalesce(p_estimated_notional, 0), 2)
        using errcode = 'P0001';
    end if;
  end if;

  -- Atomically insert the pending broker_orders row (durable reservation).
  insert into broker_orders(
    proposal_id, market, broker, broker_env, symbol, side, qty, order_type,
    limit_price, estimated_notional, currency, status, approved_by_user, submitted_at
  ) values (
    p_proposal_id, p_market, p_broker, p_broker_env, p_symbol, p_side, p_qty, p_order_type,
    p_limit_price, p_estimated_notional, p_currency, 'pending_submit', v_approved_by_user, now()
  )
  returning id into v_id;

  return v_id;
end
$function$;

-- Re-assert v2 privileges after CREATE OR REPLACE (definer stays service-only).
revoke execute on function public.reserve_live_order_budget_v2(
  bigint, text, text, text, text, text, numeric, text, numeric, numeric,
  text, integer, numeric, text
) from public, anon, authenticated;
grant execute on function public.reserve_live_order_budget_v2(
  bigint, text, text, text, text, text, numeric, text, numeric, numeric,
  text, integer, numeric, text
) to service_role;

commit;
