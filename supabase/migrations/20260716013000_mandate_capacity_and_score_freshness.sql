-- Per-market paper capacity and score-freshness policy.
-- Capacity is an entry gate only: this migration never updates positions or trades.

alter table public.trading_mandates
  add column if not exists max_open_positions integer not null default 10,
  add column if not exists max_signal_age_sessions integer not null default 2;

update public.trading_mandates
set max_open_positions = 10
where max_open_positions is null;

update public.trading_mandates
set max_signal_age_sessions = 2
where max_signal_age_sessions is null;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'trading_mandates_max_open_positions_check') then
    alter table public.trading_mandates
      add constraint trading_mandates_max_open_positions_check
      check (max_open_positions between 1 and 50);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'trading_mandates_max_signal_age_sessions_check') then
    alter table public.trading_mandates
      add constraint trading_mandates_max_signal_age_sessions_check
      check (max_signal_age_sessions between 0 and 10);
  end if;
end
$$;

create or replace function public.execute_paper_fill(
  p_signal_id uuid,
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
  p_analyst_score numeric,
  p_strategy_id text,
  p_notes text,
  p_rationale text,
  p_price_target numeric,
  p_stop_loss numeric,
  p_sector text,
  p_expected_price numeric default null,
  p_mandate_id uuid default null,
  p_mandate_version integer default null,
  p_mandate_snapshot jsonb default null,
  p_resolved_horizon_days integer default null,
  p_max_open_names integer default 10,
  p_max_sector_names integer default 3,
  p_per_trade_cap numeric default null,
  p_daily_notional_cap numeric default null,
  p_day_start timestamptz default null
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
  v_existing_qty numeric;
  v_existing_avg numeric;
  v_updated_signal uuid;
  v_realized_slip numeric;
  v_open_names integer;
  v_sector_names integer;
  v_spent_today numeric;
  v_mandate_threshold numeric;
  v_mandate_max_names integer;
  v_effective_max_names integer;
  v_global_paused boolean;
  v_global_trading boolean;
  v_market_paused boolean;
  v_market_trading boolean;
  v_data_confidence numeric;
  v_quality_status text;
  v_tainted boolean;
  v_taint_reason text;
  v_missing_dims text[];
  v_degraded_dims text[];
begin
  if p_market not in ('us', 'india') or p_qty <= 0 or p_fill_price <= 0 or p_total_cost <= 0 then
    return jsonb_build_object('ok', false, 'error', 'invalid_fill_input');
  end if;

  -- The pool lock serializes all fills for a market, including the absent-row
  -- name-cap check, so two concurrent candidates cannot both become name 11.
  select id, cash_balance into v_pool_id, v_cash
    from public.paper_portfolio where market = p_market for update;
  if v_pool_id is null then
    return jsonb_build_object('ok', false, 'error', 'pool_not_found');
  end if;
  if p_total_cost > v_cash then
    return jsonb_build_object('ok', false, 'error', 'insufficient_cash');
  end if;

  select app_paused, trading_enabled
    into v_global_paused, v_global_trading
    from public.strategy_config limit 1;
  select paused, trading_enabled
    into v_market_paused, v_market_trading
    from public.market_controls where market = p_market;
  if v_global_paused is distinct from false or v_global_trading is distinct from true
     or v_market_paused is distinct from false or v_market_trading is distinct from true then
    return jsonb_build_object('ok', false, 'error', 'market_controls_blocked');
  end if;

  select score_threshold, max_open_positions
    into v_mandate_threshold, v_mandate_max_names
    from public.trading_mandates where market = p_market;
  v_effective_max_names := least(
    greatest(1, coalesce(v_mandate_max_names, 10)),
    greatest(1, coalesce(p_max_open_names, 10))
  );
  if v_mandate_threshold is null or p_analyst_score < v_mandate_threshold then
    return jsonb_build_object('ok', false, 'error', 'below_mandate_threshold', 'threshold', v_mandate_threshold);
  end if;

  if p_per_trade_cap is not null and p_total_cost > p_per_trade_cap then
    return jsonb_build_object('ok', false, 'error', 'per_trade_notional_cap');
  end if;
  if p_daily_notional_cap is not null and p_day_start is not null then
    select coalesce(sum(total_value), 0) into v_spent_today
      from public.paper_trades
      where market = p_market and order_side = 'buy' and executed_at >= p_day_start;
    if v_spent_today + p_total_cost > p_daily_notional_cap then
      return jsonb_build_object('ok', false, 'error', 'daily_paper_notional_cap');
    end if;
  end if;

  select id, qty, avg_cost into v_existing_id, v_existing_qty, v_existing_avg
    from public.paper_positions
    where symbol = p_symbol and market = p_market and position_role = 'alpha'
    for update;

  if v_existing_id is null then
    select count(*) into v_open_names
      from public.paper_positions
      where market = p_market and position_role = 'alpha';
    if v_open_names >= v_effective_max_names then
      return jsonb_build_object('ok', false, 'error', 'max_open_names', 'current', v_open_names, 'cap', v_effective_max_names);
    end if;
    if p_sector is not null then
      select count(*) into v_sector_names
        from public.paper_positions
        where market = p_market and position_role = 'alpha' and sector = p_sector;
      if v_sector_names >= greatest(1, p_max_sector_names) then
        return jsonb_build_object('ok', false, 'error', 'sector_cap', 'sector', p_sector);
      end if;
    end if;
  elsif p_fill_price <= v_existing_avg then
    return jsonb_build_object('ok', false, 'error', 'pyramid_gate');
  end if;

  update public.agent_signals
    set status = 'paper_traded', claimed_at = null, claim_run_id = null
    where id = p_signal_id and status = 'claiming'
    returning id into v_updated_signal;
  if v_updated_signal is null then
    return jsonb_build_object('ok', false, 'error', 'signal_not_claiming');
  end if;

  if p_expected_price is not null and p_expected_price > 0 then
    v_realized_slip := (p_fill_price / p_expected_price) - 1;
  end if;

  select dq.data_confidence, dq.quality_status, dq.missing_dims, dq.degraded_dims
    into v_data_confidence, v_quality_status, v_missing_dims, v_degraded_dims
    from public.v_decision_quality dq where dq.signal_id = p_signal_id limit 1;

  if v_quality_status = 'ok' and v_data_confidence is not null and v_data_confidence < 0.5 then
    v_tainted := true;
    v_taint_reason := 'low data_confidence (' || round(v_data_confidence, 3)::text || ')'
      || case when array_length(v_missing_dims, 1) > 0 then '; missing: ' || array_to_string(v_missing_dims, ',') else '' end
      || case when array_length(v_degraded_dims, 1) > 0 then '; degraded: ' || array_to_string(v_degraded_dims, ',') else '' end;
  else
    v_tainted := false;
  end if;

  insert into public.paper_order_events (
    event_type, symbol, side, qty, fill_price, total_value, price_source,
    price_retrieved_at, bid_at_fill, ask_at_fill, spread_applied, signal_id,
    analyst_score, strategy_id, notes, market, expected_price,
    realized_slip_pct, fill_status
  ) values (
    'fill', p_symbol, 'buy', p_qty, p_fill_price, p_total_cost, p_price_source,
    p_price_retrieved_at, p_bid, p_ask, p_spread, p_signal_id,
    p_analyst_score, p_strategy_id, p_notes, p_market, p_expected_price,
    v_realized_slip, 'filled'
  ) returning id into v_event_id;

  insert into public.paper_trades (
    symbol, order_side, qty, fill_price, signal_id, analyst_score,
    direction, rationale, price_source, price_retrieved_at, spread_applied,
    paper_event_id, market, currency, data_confidence, quality_status, tainted,
    taint_reason, excluded_from_learning, expected_price, realized_slip_pct,
    fill_status, mandate_id, mandate_version, mandate_snapshot,
    resolved_horizon_days, position_role
  ) values (
    p_symbol, 'buy', p_qty, p_fill_price, p_signal_id,
    p_analyst_score, 'long', p_rationale, p_price_source,
    p_price_retrieved_at, p_spread, v_event_id, p_market, p_currency,
    v_data_confidence, coalesce(v_quality_status, 'unknown'), v_tainted,
    v_taint_reason, v_tainted, p_expected_price, v_realized_slip, 'filled',
    p_mandate_id, p_mandate_version, p_mandate_snapshot,
    p_resolved_horizon_days, 'alpha'
  ) returning id into v_trade_id;

  if v_existing_id is not null then
    update public.paper_positions set
      qty = v_existing_qty + p_qty,
      avg_cost = ((v_existing_qty * v_existing_avg) + p_total_cost) / (v_existing_qty + p_qty),
      current_price = p_fill_price,
      updated_at = now()
    where id = v_existing_id;
  else
    insert into public.paper_positions (
      symbol, qty, avg_cost, current_price, price_target, stop_loss,
      initial_stop_loss, highest_price, sector, market, currency,
      mandate_version, mandate_snapshot, resolved_horizon_days, position_role
    ) values (
      p_symbol, p_qty, p_fill_price, p_fill_price, p_price_target, p_stop_loss,
      p_stop_loss, p_fill_price, p_sector, p_market, p_currency,
      p_mandate_version, p_mandate_snapshot, p_resolved_horizon_days, 'alpha'
    );
  end if;

  update public.paper_portfolio set
    cash_balance = cash_balance - p_total_cost,
    total_invested = coalesce(total_invested, 0) + p_total_cost,
    updated_at = now()
  where id = v_pool_id;

  return jsonb_build_object(
    'ok', true, 'trade_id', v_trade_id, 'event_id', v_event_id,
    'new_cash_balance', v_cash - p_total_cost,
    'data_confidence', v_data_confidence, 'tainted', v_tainted,
    'expected_price', p_expected_price, 'realized_slip_pct', v_realized_slip
  );
end;
$$;

revoke all on function public.execute_paper_fill from public, anon, authenticated;
grant execute on function public.execute_paper_fill to service_role;
