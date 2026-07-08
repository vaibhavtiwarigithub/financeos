-- Reproducibility fix (Codex review P0-3): migration 111 was comment-only
-- ("applied to prod via MCP") and carried no executable SQL, so a fresh DB
-- rebuild from the migrations folder would recreate the OLD (migration 105)
-- reserve_live_order_budget — UTC trading day + counting 'failed'/'expired'
-- orders into the daily cap. This migration materializes the CURRENT prod
-- definition (market-local trading day; excludes error/rejected/canceled/
-- failed/expired from the daily count+notional) so repo == prod.
--
-- Body is the live prod definition (pg_get_functiondef, 2026-07-08). Idempotent
-- via CREATE OR REPLACE. SECURITY DEFINER + fixed search_path preserved.

CREATE OR REPLACE FUNCTION public.reserve_live_order_budget(
  p_proposal_id bigint, p_market text, p_broker text, p_broker_env text,
  p_symbol text, p_side text, p_qty numeric, p_order_type text,
  p_limit_price numeric, p_estimated_notional numeric, p_currency text,
  p_max_daily_trades integer, p_max_daily_notional numeric,
  p_client_order_key text DEFAULT NULL::text)
 RETURNS bigint
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_count int; v_sum numeric; v_id bigint;
  v_tz text := case p_market when 'india' then 'Asia/Kolkata' else 'America/New_York' end;
  v_day date := (now() at time zone v_tz)::date;
begin
  perform pg_advisory_xact_lock(hashtext(v_day::text || ':' || coalesce(p_market,'')));
  if p_side = 'buy' and p_broker_env = 'live' then
    select count(*), coalesce(sum(estimated_notional), 0) into v_count, v_sum
      from broker_orders
      where market = p_market and broker_env = 'live' and side = 'buy'
        and (created_at at time zone v_tz)::date = v_day
        and status not in ('error', 'rejected', 'canceled', 'failed', 'expired');
    if p_max_daily_trades is not null and v_count + 1 > p_max_daily_trades then
      raise exception 'daily_trade_limit: % live BUY orders today reaches the daily cap of %', v_count, p_max_daily_trades using errcode = 'P0001';
    end if;
    if p_max_daily_notional is not null and v_sum + coalesce(p_estimated_notional, 0) > p_max_daily_notional then
      raise exception 'daily_notional_limit: today %/% used, this order % would exceed the daily cap', round(v_sum, 2), round(p_max_daily_notional, 2), round(coalesce(p_estimated_notional, 0), 2) using errcode = 'P0001';
    end if;
  end if;
  insert into broker_orders(
    proposal_id, market, broker, broker_env, symbol, side, qty, order_type,
    limit_price, estimated_notional, currency, status, approved_by_user, submitted_at, client_order_key
  ) values (
    p_proposal_id, p_market, p_broker, p_broker_env, p_symbol, p_side, p_qty, p_order_type,
    p_limit_price, p_estimated_notional, p_currency, 'pending_submit', true, now(), p_client_order_key
  ) returning id into v_id;
  return v_id;
end $function$;
