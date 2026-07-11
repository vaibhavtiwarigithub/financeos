-- 153_budget_rpc_lock_scope_and_input_hardening.sql
-- Phase B follow-up (CODEX_PHASE_B_REMEDIATION_REVIEW_RESULT.md): two additive
-- corrections to reserve_live_order_budget_v2. Additive / behavior-tightening only;
-- never edits the applied migration 152.
--
--   1. (CRITICAL) Lock/query scope mismatch. 152 widened the advisory-lock key to
--      include p_broker, but the daily-cap count/sum it guards is MARKET-WIDE
--      (filters market + broker_env='live' + side, NOT broker). So two concurrent
--      live BUYs in the same market routed to DIFFERENT brokers take DIFFERENT
--      locks, both read the same pre-order total, and can jointly exceed the
--      market daily cap. Caps are market-wide by query design, so the correct fix
--      is to NARROW the lock to the query's scope: local_date:market:env (drop
--      broker). Now every concurrent live BUY in a market/session serializes on
--      one lock; distinct markets still hash distinct and never block each other.
--
--   2. (HIGH) Input validation was fail-open for malformed service inputs:
--        - numeric Infinity passed the "positive finite" checks (Infinity is not
--          NaN and is > 0), so an Infinity qty/notional/cap was accepted.
--        - p_side / p_broker_env / p_broker / p_symbol / p_order_type were not
--          validated, so a malformed side like 'BUY' (uppercase) skips the
--          lower-cased BUY-cap branch entirely yet still inserts a live row.
--      This function is SECURITY DEFINER and definer-run — it must fail closed on
--      malformed input, not silently reserve. Reject non-finite numerics and
--      require canonical enums / non-empty identifiers.
--
-- Idempotent: CREATE OR REPLACE + re-asserted REVOKE/GRANT.

begin;

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

  -- side / env / identifiers must be canonical. A malformed side (e.g. 'BUY')
  -- would otherwise skip the lower-cased BUY-cap branch yet still insert a row.
  if p_side not in ('buy', 'sell') then
    raise exception 'invalid_side: % (expected buy|sell)', coalesce(p_side, '<null>')
      using errcode = 'P0001';
  end if;
  if p_broker_env not in ('live', 'paper') then
    raise exception 'invalid_broker_env: % (expected live|paper)', coalesce(p_broker_env, '<null>')
      using errcode = 'P0001';
  end if;
  if p_broker is null or length(btrim(p_broker)) = 0 then
    raise exception 'invalid_broker: must be a non-empty broker id' using errcode = 'P0001';
  end if;
  if p_symbol is null or length(btrim(p_symbol)) = 0 then
    raise exception 'invalid_symbol: must be a non-empty symbol' using errcode = 'P0001';
  end if;
  if p_order_type is null or length(btrim(p_order_type)) = 0 then
    raise exception 'invalid_order_type: must be a non-empty order type' using errcode = 'P0001';
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

  -- positive, FINITE quantity. Postgres numeric admits both 'NaN' and 'Infinity';
  -- Infinity is > 0 and not NaN, so it must be rejected explicitly.
  if p_qty is null or p_qty = 'NaN'::numeric
     or p_qty = 'Infinity'::numeric or p_qty = '-Infinity'::numeric
     or p_qty <= 0 then
    raise exception 'invalid_qty: must be a positive finite number'
      using errcode = 'P0001';
  end if;

  -- caps, when supplied, must be finite and non-negative (Infinity/NaN would
  -- disable the cap silently; a negative cap would reject everything oddly).
  if p_max_daily_notional is not null
     and (p_max_daily_notional = 'NaN'::numeric
          or p_max_daily_notional = 'Infinity'::numeric
          or p_max_daily_notional = '-Infinity'::numeric
          or p_max_daily_notional < 0) then
    raise exception 'invalid_max_daily_notional: must be a finite non-negative number'
      using errcode = 'P0001';
  end if;

  -- a live BUY reservation must carry a positive finite notional (the cap math
  -- and the notional-limit gate both depend on it).
  if p_side = 'buy' and p_broker_env = 'live'
     and (p_estimated_notional is null
          or p_estimated_notional = 'NaN'::numeric
          or p_estimated_notional = 'Infinity'::numeric
          or p_estimated_notional = '-Infinity'::numeric
          or p_estimated_notional <= 0) then
    raise exception 'invalid_notional: live BUY requires a positive finite estimated_notional'
      using errcode = 'P0001';
  end if;

  v_approved_by_user := (p_execution_actor = 'owner');

  -- Market-local session day: local midnight, converted back to a UTC instant
  -- for comparison against broker_orders.created_at (timestamptz).
  v_local_date := (now() at time zone v_tz)::date;
  v_day_start  := (v_local_date::timestamp) at time zone v_tz;

  -- Serialize concurrent live orders for the same market + env + local session
  -- day. Scope MUST match the count/sum below (market-wide, live). Do NOT include
  -- broker: the cap is market-wide, so a broker in the key would let two brokers
  -- in one market take different locks and both pass a shared cap. Distinct
  -- markets still hash distinct and never block each other.
  perform pg_advisory_xact_lock(hashtext(
    v_local_date::text || ':' || coalesce(p_market, '')
      || ':' || coalesce(p_broker_env, '')
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
