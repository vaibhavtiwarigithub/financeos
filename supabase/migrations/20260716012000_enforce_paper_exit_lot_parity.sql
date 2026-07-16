-- Fail closed when aggregate open lots do not exactly match the position.
-- This prevents an exit from creating or preserving orphan paper lots.

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
