-- Paper autonomy safety: canonical mandate entries, latched controls in app,
-- bounded names, and transactional full/partial exits.

drop function if exists public.execute_paper_fill(
  uuid, text, text, text, numeric, numeric, numeric, text, timestamptz,
  numeric, numeric, numeric, numeric, text, text, text, numeric, numeric,
  text, numeric
);

create function public.execute_paper_fill(
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

  select score_threshold into v_mandate_threshold
    from public.trading_mandates where market = p_market;
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
    if v_open_names >= greatest(1, p_max_open_names) then
      return jsonb_build_object('ok', false, 'error', 'max_open_names', 'current', v_open_names, 'cap', p_max_open_names);
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

create or replace function public.execute_paper_exit(
  p_position_id uuid,
  p_exit_price numeric,
  p_exit_reason text,
  p_exit_qty numeric default null,
  p_partial_stop_loss numeric default null
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_pos public.paper_positions%rowtype;
  v_pool_id uuid;
  v_close_qty numeric;
  v_remaining numeric;
  v_open_lot_qty numeric;
  v_to_close numeric;
  v_take numeric;
  v_lot public.paper_trades%rowtype;
  v_lot_pnl numeric;
  v_lot_pnl_pct numeric;
  v_outcome text;
  v_realized numeric := 0;
  v_proceeds numeric;
  v_remaining_lot_id uuid;
  v_closed_trade_ids uuid[] := array[]::uuid[];
  v_now timestamptz := now();
begin
  if p_exit_price is null or p_exit_price <= 0 or nullif(trim(p_exit_reason), '') is null then
    return jsonb_build_object('ok', false, 'error', 'invalid_exit_input');
  end if;

  select * into v_pos from public.paper_positions where id = p_position_id for update;
  if not found then
    return jsonb_build_object('ok', false, 'error', 'position_not_found');
  end if;

  v_close_qty := coalesce(p_exit_qty, v_pos.qty);
  if v_close_qty <= 0 or v_close_qty > v_pos.qty then
    return jsonb_build_object('ok', false, 'error', 'invalid_exit_qty');
  end if;

  select id into v_pool_id from public.paper_portfolio
    where market = v_pos.market for update;
  if v_pool_id is null then
    return jsonb_build_object('ok', false, 'error', 'pool_not_found');
  end if;

  select coalesce(sum(qty), 0) into v_open_lot_qty
    from public.paper_trades
    where symbol = v_pos.symbol and market = v_pos.market and closed_at is null
      and position_role = v_pos.position_role;
  if v_open_lot_qty <> v_pos.qty then
    return jsonb_build_object('ok', false, 'error', 'position_lot_qty_mismatch', 'lots', v_open_lot_qty, 'position', v_pos.qty);
  end if;

  v_to_close := v_close_qty;
  for v_lot in
    select * from public.paper_trades
    where symbol = v_pos.symbol and market = v_pos.market and closed_at is null
      and position_role = v_pos.position_role
    order by executed_at, id
    for update
  loop
    exit when v_to_close <= 0;
    v_take := least(v_lot.qty, v_to_close);
    v_lot_pnl := (p_exit_price - v_lot.fill_price) * v_take;
    v_lot_pnl_pct := case when v_lot.fill_price > 0
      then ((p_exit_price - v_lot.fill_price) / v_lot.fill_price) * 100 else 0 end;
    v_outcome := case when v_lot_pnl_pct > 0.1 then 'win'
      when v_lot_pnl_pct < -0.1 then 'loss' else 'breakeven' end;

    if v_take = v_lot.qty then
      update public.paper_trades set
        exit_price = p_exit_price, realized_pnl = v_lot_pnl,
        pnl_pct = v_lot_pnl_pct, realized_pnl_pct = v_lot_pnl_pct,
        outcome = v_outcome, exit_reason = p_exit_reason,
        closed_at = v_now, exit_at = v_now
      where id = v_lot.id;
      v_closed_trade_ids := array_append(v_closed_trade_ids, v_lot.id);
    else
      -- Keep the original id on the realized slice (stable audit reference) and
      -- clone the remaining open quantity. total_value is generated from
      -- qty*fill_price, so it must never be named in INSERT/UPDATE.
      update public.paper_trades set
        qty = v_take,
        quantity = case when quantity is null then null else v_take::integer end,
        exit_price = p_exit_price, realized_pnl = v_lot_pnl,
        pnl_pct = v_lot_pnl_pct, realized_pnl_pct = v_lot_pnl_pct,
        outcome = v_outcome, exit_reason = p_exit_reason,
        closed_at = v_now, exit_at = v_now
      where id = v_lot.id;
      v_remaining_lot_id := gen_random_uuid();
      insert into public.paper_trades (
        id, symbol, order_side, qty, fill_price, signal_id, analyst_score,
        direction, rationale, fundamental_score, technical_score,
        sentiment_score, macro_score, executed_at, agent_label, price_source,
        price_retrieved_at, spread_applied, paper_event_id, entry_price,
        quantity, stop_loss, take_profit, highest_price, entry_signal_score,
        spy_price_at_entry, llm_exit, market, currency, data_confidence,
        quality_status, tainted, taint_reason, excluded_from_learning,
        expected_price, realized_slip_pct, fill_status, mandate_id,
        mandate_version, mandate_snapshot, resolved_horizon_days,
        position_role, hedge_event_id
      ) values (
        v_remaining_lot_id, v_lot.symbol, v_lot.order_side, v_lot.qty-v_take,
        v_lot.fill_price, v_lot.signal_id, v_lot.analyst_score,
        v_lot.direction, v_lot.rationale, v_lot.fundamental_score,
        v_lot.technical_score, v_lot.sentiment_score, v_lot.macro_score,
        v_lot.executed_at, v_lot.agent_label, v_lot.price_source,
        v_lot.price_retrieved_at, v_lot.spread_applied, v_lot.paper_event_id,
        v_lot.entry_price,
        case when v_lot.quantity is null then null else (v_lot.qty-v_take)::integer end,
        v_lot.stop_loss, v_lot.take_profit, v_lot.highest_price,
        v_lot.entry_signal_score, v_lot.spy_price_at_entry, v_lot.llm_exit,
        v_lot.market, v_lot.currency, v_lot.data_confidence,
        v_lot.quality_status, v_lot.tainted, v_lot.taint_reason,
        v_lot.excluded_from_learning, v_lot.expected_price,
        v_lot.realized_slip_pct, v_lot.fill_status, v_lot.mandate_id,
        v_lot.mandate_version, v_lot.mandate_snapshot,
        v_lot.resolved_horizon_days, v_lot.position_role, v_lot.hedge_event_id
      );
      v_closed_trade_ids := array_append(v_closed_trade_ids, v_lot.id);
    end if;

    v_realized := v_realized + v_lot_pnl;
    v_to_close := v_to_close - v_take;
  end loop;

  if v_to_close <> 0 then
    raise exception 'paper exit lot allocation incomplete: %', v_to_close;
  end if;

  v_remaining := v_pos.qty - v_close_qty;
  if v_remaining = 0 then
    delete from public.paper_positions where id = v_pos.id;
  else
    update public.paper_positions set
      qty = v_remaining,
      current_price = p_exit_price,
      stop_loss = coalesce(p_partial_stop_loss, stop_loss),
      price_target = null,
      highest_price = greatest(coalesce(highest_price, p_exit_price), p_exit_price),
      updated_at = v_now
    where id = v_pos.id;
  end if;

  v_proceeds := v_close_qty * p_exit_price;
  update public.paper_portfolio set
    cash_balance = cash_balance + v_proceeds,
    updated_at = v_now
  where id = v_pool_id;

  insert into public.decision_journal (
    entry_type, symbol, market, summary, calculations,
    has_verified_facts, has_calculations, resolved, resolved_at
  ) values (
    'paper_exit', v_pos.symbol, v_pos.market,
    format('Paper exit (%s): %s x %s at %s (%s)', upper(v_pos.market), v_close_qty, v_pos.symbol, p_exit_price, p_exit_reason),
    jsonb_build_object(
      'market', v_pos.market, 'currency', v_pos.currency,
      'qty', v_close_qty, 'remaining_qty', v_remaining,
      'exit_price', p_exit_price, 'avg_cost', v_pos.avg_cost,
      'realized_pnl', v_realized, 'exit_reason', p_exit_reason
    ),
    true, true, true, v_now
  );

  return jsonb_build_object(
    'ok', true, 'symbol', v_pos.symbol, 'market', v_pos.market,
    'currency', v_pos.currency, 'closed_qty', v_close_qty,
    'remaining_qty', v_remaining, 'proceeds', v_proceeds,
    'realized_pnl', v_realized, 'closed_trade_ids', to_jsonb(v_closed_trade_ids)
  );
end;
$$;

revoke all on function public.execute_paper_exit from public, anon, authenticated;
grant execute on function public.execute_paper_exit to service_role;

comment on function public.execute_paper_exit is
  'Atomic FIFO paper exit: realizes full/partial lots, updates position and market cash, and journals the exit in one transaction.';

-- Collapse same-provider budget pressure once the stronger exhausted state is
-- open. New calls also resolve this in application code.
update public.agent_alerts pressure
set resolved = true, resolved_at = now()
where pressure.resolved = false
  and pressure.issue_key like 'provider-budget-pressure:%'
  and exists (
    select 1 from public.agent_alerts exhausted
    where exhausted.resolved = false
      and exhausted.issue_key = replace(pressure.issue_key, 'provider-budget-pressure:', 'provider-budget-exhausted:')
  );
