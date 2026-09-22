-- Dedicated SOXL paper-entry path. Owner-approved 2026-09-22: automatic
-- PAPER trading for SOXL/SOXX, 5% NAV ceiling, instrument-specific sizing.
--
-- WHY A NEW RPC, NOT execute_paper_fill: that RPC is hardcoded to
-- position_role = 'alpha' and requires a claimed public.agent_signals row
-- (mandate/sector-cap machinery for the ordinary research pipeline). SOXL's
-- setup is computed by lib/trading/soxl-lifecycle.ts (planSoxlEntry), a pure
-- function with no agent_signals row -- forcing it through execute_paper_fill
-- would mean fabricating a fake signal to satisfy that contract. A dedicated
-- RPC keeps the leveraged sleeve on its own path, as approved, with live
-- execution completely untouched (this RPC never reads broker_orders and
-- nothing calls it from any live path).
--
-- WHY execute_paper_exit IS NOT DUPLICATED: it already operates generically
-- on `position_role` (see its FIFO lot loop), so it works unchanged for a
-- 'soxl_paper' position. Only the entry side needed a new function.
--
-- Idempotency/no-pyramiding: SOXL never averages in (semiconductorCapacity
-- rejects any existing SOXL position). The row lock + "no existing open
-- soxl_paper position" check below is therefore both the business rule and
-- the concurrency/retry guard in one place -- a retried fill call after a
-- successful first one sees the just-inserted position and is rejected.

alter table public.paper_positions drop constraint if exists paper_positions_position_role_check;
alter table public.paper_positions add constraint paper_positions_position_role_check
  check (position_role = any (array['alpha'::text, 'hedge'::text, 'soxl_paper'::text]));

alter table public.paper_trades drop constraint if exists paper_trades_position_role_check;
alter table public.paper_trades add constraint paper_trades_position_role_check
  check (position_role = any (array['alpha'::text, 'hedge'::text, 'soxl_paper'::text]));

create or replace function public.execute_soxl_paper_fill(
  p_market text,
  p_currency text,
  p_symbol text,
  p_qty numeric,
  p_fill_price numeric,
  p_total_cost numeric,
  p_price_source text,
  p_price_retrieved_at timestamptz,
  p_bid numeric,
  p_ask numeric,
  p_spread numeric,
  p_stop_loss numeric,
  p_price_target numeric,
  p_policy_version text,
  p_rationale text
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_pool_id uuid;
  v_cash numeric;
  v_event_id bigint;
  v_trade_id uuid;
  v_existing_id uuid;
  v_global_paused boolean;
  v_global_trading boolean;
  v_market_paused boolean;
  v_market_trading boolean;
begin
  if p_symbol <> 'SOXL' or p_market <> 'us' or p_qty <= 0 or p_fill_price <= 0 or p_total_cost <= 0
     or p_stop_loss is null or p_stop_loss <= 0 or p_stop_loss >= p_fill_price
     or p_price_target is null or p_price_target <= p_fill_price
     or nullif(trim(p_policy_version), '') is null then
    return jsonb_build_object('ok', false, 'error', 'invalid_fill_input');
  end if;

  -- Same pool-lock-first pattern as execute_paper_fill: serializes every fill
  -- (including this one) against concurrent callers touching the US book.
  select id, cash_balance into v_pool_id, v_cash
    from public.paper_portfolio where market = p_market for update;
  if v_pool_id is null then
    return jsonb_build_object('ok', false, 'error', 'pool_not_found');
  end if;
  if p_total_cost > v_cash then
    return jsonb_build_object('ok', false, 'error', 'insufficient_cash');
  end if;

  select app_paused, trading_enabled into v_global_paused, v_global_trading
    from public.strategy_config limit 1;
  select paused, trading_enabled into v_market_paused, v_market_trading
    from public.market_controls where market = p_market;
  if v_global_paused is distinct from false or v_global_trading is distinct from true
     or v_market_paused is distinct from false or v_market_trading is distinct from true then
    return jsonb_build_object('ok', false, 'error', 'market_controls_blocked');
  end if;

  select id into v_existing_id from public.paper_positions
    where symbol = p_symbol and market = p_market and position_role = 'soxl_paper'
    for update;
  if v_existing_id is not null then
    return jsonb_build_object('ok', false, 'error', 'existing_soxl_position');
  end if;

  insert into public.paper_order_events (
    event_type, symbol, side, qty, fill_price, total_value, price_source,
    price_retrieved_at, bid_at_fill, ask_at_fill, spread_applied,
    strategy_id, notes, market, fill_status
  ) values (
    'fill', p_symbol, 'buy', p_qty, p_fill_price, p_total_cost, p_price_source,
    p_price_retrieved_at, p_bid, p_ask, p_spread,
    p_policy_version, p_rationale, p_market, 'filled'
  ) returning id into v_event_id;

  insert into public.paper_trades (
    symbol, order_side, qty, fill_price, direction, rationale,
    price_source, price_retrieved_at, spread_applied, paper_event_id,
    market, currency, fill_status, position_role
  ) values (
    p_symbol, 'buy', p_qty, p_fill_price, 'long', p_rationale,
    p_price_source, p_price_retrieved_at, p_spread, v_event_id,
    p_market, p_currency, 'filled', 'soxl_paper'
  ) returning id into v_trade_id;

  insert into public.paper_positions (
    symbol, qty, avg_cost, current_price, price_target, stop_loss,
    initial_stop_loss, highest_price, sector, market, currency, position_role
  ) values (
    p_symbol, p_qty, p_fill_price, p_fill_price, p_price_target, p_stop_loss,
    p_stop_loss, p_fill_price, 'semiconductors', p_market, p_currency, 'soxl_paper'
  );

  update public.paper_portfolio set
    cash_balance = cash_balance - p_total_cost,
    total_invested = coalesce(total_invested, 0) + p_total_cost,
    updated_at = now()
  where id = v_pool_id;

  return jsonb_build_object(
    'ok', true, 'trade_id', v_trade_id, 'event_id', v_event_id,
    'new_cash_balance', v_cash - p_total_cost
  );
end;
$$;

revoke all on function public.execute_soxl_paper_fill from public, anon, authenticated;
grant execute on function public.execute_soxl_paper_fill to service_role;

comment on function public.execute_soxl_paper_fill is
  'Dedicated SOXL paper-entry RPC (position_role=soxl_paper). Not called from any live path. Exits reuse the existing, already position-role-generic execute_paper_exit RPC unchanged.';
