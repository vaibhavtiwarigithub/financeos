-- Risk fixes G4/G5/G6: daily cumulative live-order budget, enforced atomically.
--
-- Per-order caps (migration 103) don't bound total same-day risk, and max_daily_trades
-- was an orphan column enforced nowhere. This adds owner-set daily caps and an atomic
-- reserve-and-insert RPC that closes the TOCTOU race where concurrent live orders could
-- each pass a client-side count/sum before inserting.
--
-- Limits apply to BUY (new-risk) orders only, so a SELL exit is never blocked.
-- Caps are nullable → a null cap for that market means "daily limit not enforced yet"
-- (the per-order cap + kill switch still apply). Owner sets them in Settings.

alter table strategy_config
  add column if not exists max_daily_notional_usd numeric,
  add column if not exists max_daily_notional_inr numeric;
-- max_daily_trades already exists (was an orphan); it is now read by the RPC below.

comment on column strategy_config.max_daily_notional_usd is 'Max cumulative USD notional of live BUY orders per day (US). Owner-set in Settings. NULL = not enforced.';
comment on column strategy_config.max_daily_notional_inr is 'Max cumulative INR notional of live BUY orders per day (India). Owner-set in Settings. NULL = not enforced.';
comment on column strategy_config.max_daily_trades is 'Max live BUY orders per day, per market. Owner-set in Settings. NULL = not enforced. Enforced atomically by reserve_live_order_budget().';

alter table broker_orders
  add column if not exists estimated_notional numeric,
  add column if not exists currency text;

comment on column broker_orders.estimated_notional is 'qty x validation price at submit, in the market currency. Basis for the daily cumulative notional cap.';

-- Atomic reserve-and-insert. Runs in one transaction holding a per-(day,market)
-- advisory lock, so concurrent live orders serialize: each sees the prior ones''
-- reservations. Inserts the pending broker_orders row itself (durable reservation),
-- returning its id. The partial unique dup-submit index still fires on a duplicate
-- proposal, raising 23505 which the caller maps to 409.
create or replace function reserve_live_order_budget(
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
  p_max_daily_trades int,
  p_max_daily_notional numeric
) returns bigint
language plpgsql
security definer
set search_path = public
as $$
declare
  v_count int;
  v_sum numeric;
  v_id bigint;
begin
  -- Serialize concurrent live orders for the same market+day.
  perform pg_advisory_xact_lock(hashtext(current_date::text || ':' || coalesce(p_market,'')));

  -- Daily caps apply to LIVE BUY orders only. Paper orders and SELL exits are exempt.
  if p_side = 'buy' and p_broker_env = 'live' then
    select count(*), coalesce(sum(estimated_notional), 0)
      into v_count, v_sum
      from broker_orders
      where market = p_market
        and broker_env = 'live'
        and side = 'buy'
        and created_at >= date_trunc('day', now())
        and status not in ('error', 'rejected', 'canceled');

    if p_max_daily_trades is not null and v_count + 1 > p_max_daily_trades then
      raise exception 'daily_trade_limit: % live BUY orders today reaches the daily cap of %', v_count, p_max_daily_trades
        using errcode = 'P0001';
    end if;

    if p_max_daily_notional is not null
       and v_sum + coalesce(p_estimated_notional, 0) > p_max_daily_notional then
      raise exception 'daily_notional_limit: today %/% used, this order % would exceed the daily cap',
        round(v_sum, 2), round(p_max_daily_notional, 2), round(coalesce(p_estimated_notional, 0), 2)
        using errcode = 'P0001';
    end if;
  end if;

  insert into broker_orders(
    proposal_id, market, broker, broker_env, symbol, side, qty, order_type,
    limit_price, estimated_notional, currency, status, approved_by_user, submitted_at
  ) values (
    p_proposal_id, p_market, p_broker, p_broker_env, p_symbol, p_side, p_qty, p_order_type,
    p_limit_price, p_estimated_notional, p_currency, 'pending_submit', true, now()
  )
  returning id into v_id;

  return v_id;
end
$$;

revoke all on function reserve_live_order_budget(bigint, text, text, text, text, text, numeric, text, numeric, numeric, text, int, numeric) from public;
grant execute on function reserve_live_order_budget(bigint, text, text, text, text, text, numeric, text, numeric, numeric, text, int, numeric) to service_role;
