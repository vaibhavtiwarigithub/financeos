-- W2-full: restore partial profit-taking exits.
--
-- Root cause of W2-interim disable (2026-08-16):
-- execute_paper_exit's partial-exit branch INSERTs a residual open lot into
-- paper_trades with order_side='buy'. Three objects added by
-- 20260806203000_prevent_paper_alpha_pyramiding.sql reject that insert:
--   1. prevent_paper_alpha_pyramid trigger → 'existing_open_position' exception
--   2. paper_trades_buy_event_unique index → paper_event_id duplicate
--   3. paper_trades_buy_signal_unique index → (market, signal_id) duplicate
-- The exception propagated out of the RPC, aborting the entire PositionMonitor
-- run — every open position's stop and target was then silently unevaluated.
--
-- Fix: add partial_exit_lot boolean. Residual lots created by a partial exit
-- set this flag. All three blocking objects are updated to exempt flagged rows.
-- No data is lost; existing rows default to false.

-- 1. Column ---------------------------------------------------------------
alter table public.paper_trades
  add column if not exists partial_exit_lot boolean not null default false;

comment on column public.paper_trades.partial_exit_lot is
  'True on the residual open lot created when a partial exit splits a position.
   Exempts the row from the anti-pyramiding trigger and buy-signal unique indexes,
   which would otherwise reject it as a duplicate or new pyramid entry.';

-- 2. Recreate unique indexes to exclude residual lots ----------------------
-- Both indexes are conditional on order_side=''buy'', so residual lots were
-- already creating collisions on paper_event_id and signal_id.
drop index if exists public.paper_trades_buy_event_unique;
create unique index paper_trades_buy_event_unique
  on public.paper_trades (paper_event_id)
  where order_side = 'buy' and paper_event_id is not null and not partial_exit_lot;

drop index if exists public.paper_trades_buy_signal_unique;
create unique index paper_trades_buy_signal_unique
  on public.paper_trades (market, signal_id)
  where order_side = 'buy' and signal_id is not null and not partial_exit_lot;

-- 3. Update anti-pyramiding trigger to exempt residual lots ---------------
create or replace function public.prevent_paper_alpha_pyramid()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  -- Residual open lots created by a partial exit are NOT new pyramid entries;
  -- they represent the remaining qty of a position already tracked in
  -- paper_positions. Exempt them from the open-position check.
  if new.order_side = 'buy'
     and coalesce(new.position_role, 'alpha') = 'alpha'
     and not coalesce(new.partial_exit_lot, false)
     and exists (
       select 1
       from public.paper_positions position
       where position.market = new.market
         and upper(position.symbol) = upper(new.symbol)
         and coalesce(position.position_role, 'alpha') = 'alpha'
     ) then
    raise exception using
      errcode = 'P0001',
      message = 'existing_open_position';
  end if;
  return new;
end;
$$;

-- 4. Update execute_paper_exit to mark residual lots ----------------------
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
      and position_role = v_pos.position_role
      -- Residual lots (partial_exit_lot=true) are part of the open quantity;
      -- include them in the parity check.
      ;
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
      -- Close the exited slice (keep id stable — the audit reference).
      -- Clone remaining open quantity as a residual lot flagged partial_exit_lot=true.
      -- The flag exempts it from the anti-pyramiding trigger and the
      -- buy_event_unique / buy_signal_unique partial indexes.
      -- total_value is a generated column (qty*fill_price); never name it in DML.
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
        position_role, hedge_event_id,
        partial_exit_lot   -- W2-full: exempt from anti-pyramiding checks
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
        v_lot.resolved_horizon_days, v_lot.position_role, v_lot.hedge_event_id,
        true   -- partial_exit_lot
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
  'Closes a paper position (full or partial). Partial exits create a residual lot
   marked partial_exit_lot=true, exempting it from anti-pyramiding checks and
   buy-signal uniqueness constraints. W2-full (2026-08-17).';
