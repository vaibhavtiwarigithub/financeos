-- Capital-rotation Phase 1 (PAPER) — atomic sell-to-fund-buy RPC.
-- Sells the weakest still-valid paper holding and buys the better candidate in ONE
-- transaction: if the candidate can't be funded even after the sale, the whole
-- thing rolls back (never leaves the book in cash — the P0-1 guardrail). Idempotent
-- on idempotency_key. service_role only. Shipped OFF: the TS caller only invokes it
-- when rotation_config.rotation_paper_execute_enabled = true (default false) and
-- every guardrail (persistence, cooldown, per-run/day caps) passes.
-- (Applied to prod via execute_sql on 2026-07-13; this file is the durable record.)

create or replace function public.execute_paper_rotation(
  p_market text, p_currency text, p_source_position_id uuid,
  p_candidate_symbol text, p_candidate_signal_id uuid, p_candidate_qty numeric,
  p_candidate_fill_price numeric, p_candidate_price_target numeric, p_candidate_stop_loss numeric,
  p_candidate_sector text, p_candidate_score numeric, p_source_score numeric,
  p_score_edge numeric, p_idempotency_key text, p_gate_json jsonb
) returns jsonb
language plpgsql security definer set search_path to 'public'
as $function$
declare
  v_pool_id uuid; v_cash numeric; v_src paper_positions%rowtype;
  v_sell_price numeric; v_proceeds numeric; v_realized numeric; v_buy_cost numeric;
  v_sell_event bigint; v_buy_event bigint; v_sell_trade uuid; v_buy_trade uuid;
  v_exist_qty numeric; v_exist_avg numeric;
begin
  if exists (select 1 from rotation_events where idempotency_key = p_idempotency_key and status = 'paper_executed') then
    return jsonb_build_object('ok', true, 'already', true);
  end if;
  select id, cash_balance into v_pool_id, v_cash from paper_portfolio where market = p_market for update;
  if v_pool_id is null then return jsonb_build_object('ok', false, 'error', 'pool_not_found'); end if;
  select * into v_src from paper_positions where id = p_source_position_id and market = p_market for update;
  if v_src.id is null then return jsonb_build_object('ok', false, 'error', 'source_position_missing'); end if;
  v_sell_price := coalesce(nullif(v_src.current_price, 0), v_src.avg_cost);
  if v_sell_price is null or v_sell_price <= 0 then return jsonb_build_object('ok', false, 'error', 'source_unpriceable'); end if;
  v_proceeds := v_src.qty * v_sell_price;
  v_realized := (v_sell_price - v_src.avg_cost) * v_src.qty;
  v_buy_cost := p_candidate_qty * p_candidate_fill_price;
  if p_candidate_qty is null or p_candidate_qty < 1 or p_candidate_fill_price is null or p_candidate_fill_price <= 0 then
    return jsonb_build_object('ok', false, 'error', 'invalid_candidate_order');
  end if;
  if v_buy_cost > v_cash + v_proceeds then
    return jsonb_build_object('ok', false, 'error', 'candidate_unfunded_after_sale');
  end if;
  insert into paper_order_events (event_type, symbol, side, qty, fill_price, total_value, price_source, market, fill_status)
    values ('fill', v_src.symbol, 'sell', v_src.qty, v_sell_price, v_proceeds, 'capital_rotation', p_market, 'filled') returning id into v_sell_event;
  insert into paper_trades (symbol, order_side, qty, fill_price, exit_price, realized_pnl, exit_reason, exit_at, closed_at, executed_at, direction, market, currency, paper_event_id, fill_status)
    values (v_src.symbol, 'sell', v_src.qty, v_sell_price, v_sell_price, v_realized, 'capital_rotation', now(), now(), now(), 'long', p_market, p_currency, v_sell_event, 'filled') returning id into v_sell_trade;
  delete from paper_positions where id = v_src.id;
  insert into paper_order_events (event_type, symbol, side, qty, fill_price, total_value, price_source, signal_id, market, fill_status)
    values ('fill', p_candidate_symbol, 'buy', p_candidate_qty, p_candidate_fill_price, v_buy_cost, 'capital_rotation', p_candidate_signal_id, p_market, 'filled') returning id into v_buy_event;
  insert into paper_trades (symbol, order_side, qty, fill_price, signal_id, analyst_score, direction, paper_event_id, market, currency, fill_status, rationale)
    values (p_candidate_symbol, 'buy', p_candidate_qty, p_candidate_fill_price, p_candidate_signal_id, p_candidate_score, 'long', v_buy_event, p_market, p_currency, 'filled', 'capital rotation entry') returning id into v_buy_trade;
  select qty, avg_cost into v_exist_qty, v_exist_avg from paper_positions where symbol = p_candidate_symbol and market = p_market for update;
  if v_exist_qty is not null then
    update paper_positions set qty = v_exist_qty + p_candidate_qty, avg_cost = ((v_exist_qty * v_exist_avg) + v_buy_cost) / (v_exist_qty + p_candidate_qty), current_price = p_candidate_fill_price, updated_at = now() where symbol = p_candidate_symbol and market = p_market;
  else
    insert into paper_positions (symbol, qty, avg_cost, current_price, price_target, stop_loss, initial_stop_loss, highest_price, sector, market, currency, opened_at)
      values (p_candidate_symbol, p_candidate_qty, p_candidate_fill_price, p_candidate_fill_price, p_candidate_price_target, p_candidate_stop_loss, p_candidate_stop_loss, p_candidate_fill_price, p_candidate_sector, p_market, p_currency, now());
  end if;
  update agent_signals set status = 'paper_traded', claimed_at = null, claim_run_id = null where id = p_candidate_signal_id and status in ('claiming', 'claimed');
  update paper_portfolio set cash_balance = cash_balance + v_proceeds - v_buy_cost, total_pnl = coalesce(total_pnl, 0) + v_realized, total_trades = coalesce(total_trades, 0) + 1, winning_trades = coalesce(winning_trades, 0) + case when v_realized > 0 then 1 else 0 end, updated_at = now() where id = v_pool_id;
  insert into rotation_events (market, currency, book_type, idempotency_key, status, candidate_symbol, source_symbol, candidate_signal_id, source_position_id, candidate_score, source_score, score_edge, sell_notional, buy_notional, turnover_consumed, cost_model_json, tax_model_json, gate_results_json, audit_json, paper_trade_ids)
    values (p_market, p_currency, 'paper', p_idempotency_key, 'paper_executed', p_candidate_symbol, v_src.symbol, p_candidate_signal_id, p_source_position_id, p_candidate_score, p_source_score, p_score_edge, v_proceeds, v_buy_cost, v_proceeds + v_buy_cost, jsonb_build_object('phase','p1_paper','costs_applied',false), jsonb_build_object('phase','p1_paper','tax_drag_applied',false), p_gate_json, jsonb_build_object('executed', true), jsonb_build_array(v_sell_trade, v_buy_trade))
    on conflict (idempotency_key) do nothing;
  return jsonb_build_object('ok', true, 'sell_trade_id', v_sell_trade, 'buy_trade_id', v_buy_trade, 'proceeds', v_proceeds, 'realized_pnl', v_realized, 'new_cash', v_cash + v_proceeds - v_buy_cost);
end;
$function$;

revoke all on function public.execute_paper_rotation(text,text,uuid,text,uuid,numeric,numeric,numeric,numeric,text,numeric,numeric,numeric,text,jsonb) from public, anon, authenticated;
grant execute on function public.execute_paper_rotation(text,text,uuid,text,uuid,numeric,numeric,numeric,numeric,text,numeric,numeric,numeric,text,jsonb) to service_role;
