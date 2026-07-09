-- 127 — execute_paper_fill: clear claim stamps on finalize (additive behavior)
--
-- Companion to migration 126. When a fill succeeds, the claiming→paper_traded
-- CAS now also clears claimed_at/claim_run_id so a paper_traded row carries no
-- stale claim ownership (keeps the stale-claiming watchdog's future scope clean
-- and makes the row's claim fields honest). CAS predicate and every ledger
-- insert are byte-for-byte unchanged — only the two null-outs are added.
-- Idempotent full-body replacement (no signature change).

CREATE OR REPLACE FUNCTION public.execute_paper_fill(p_signal_id uuid, p_market text, p_currency text, p_symbol text, p_qty numeric, p_fill_price numeric, p_total_cost numeric, p_price_source text, p_price_retrieved_at timestamp with time zone, p_bid numeric, p_ask numeric, p_spread numeric, p_analyst_score numeric, p_strategy_id text, p_notes text, p_rationale text, p_price_target numeric, p_stop_loss numeric, p_sector text, p_expected_price numeric DEFAULT NULL::numeric)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_pool_id uuid;
  v_cash numeric;
  v_total_invested numeric;
  v_event_id bigint;
  v_trade_id uuid;
  v_existing_id uuid;
  v_existing_qty numeric;
  v_existing_avg numeric;
  v_updated_signal uuid;
  v_realized_slip numeric;
  v_data_confidence   numeric;
  v_quality_status    text;
  v_tainted           boolean;
  v_taint_reason      text;
  v_missing_dims      text[];
  v_degraded_dims     text[];
begin
  select id, cash_balance, coalesce(total_invested, 0)
    into v_pool_id, v_cash, v_total_invested
    from paper_portfolio where market = p_market for update;

  if v_pool_id is null then
    return jsonb_build_object('ok', false, 'error', 'pool_not_found');
  end if;
  if p_total_cost > v_cash then
    return jsonb_build_object('ok', false, 'error', 'insufficient_cash');
  end if;

  update agent_signals set status = 'paper_traded', claimed_at = null, claim_run_id = null
    where id = p_signal_id and status = 'claiming'
    returning id into v_updated_signal;
  if v_updated_signal is null then
    return jsonb_build_object('ok', false, 'error', 'signal_not_claiming');
  end if;

  if p_expected_price is not null and p_expected_price > 0 then
    v_realized_slip := (p_fill_price / p_expected_price) - 1;
  else
    v_realized_slip := null;
  end if;

  select dq.data_confidence, dq.quality_status, dq.missing_dims, dq.degraded_dims
    into v_data_confidence, v_quality_status, v_missing_dims, v_degraded_dims
    from v_decision_quality dq
    where dq.signal_id = p_signal_id
    limit 1;

  if v_quality_status = 'ok' and v_data_confidence is not null and v_data_confidence < 0.5 then
    v_tainted := true;
    v_taint_reason := 'low data_confidence (' || round(v_data_confidence, 3)::text || ')'
      || case when array_length(v_missing_dims, 1) > 0
              then '; missing: ' || array_to_string(v_missing_dims, ',')
              else '' end
      || case when array_length(v_degraded_dims, 1) > 0
              then '; degraded: ' || array_to_string(v_degraded_dims, ',')
              else '' end;
  else
    v_tainted := false;
    v_taint_reason := null;
  end if;

  insert into paper_order_events (
    event_type, symbol, side, qty, fill_price, total_value, price_source,
    price_retrieved_at, bid_at_fill, ask_at_fill, spread_applied, signal_id,
    analyst_score, strategy_id, notes, market,
    expected_price, realized_slip_pct, fill_status
  ) values (
    'fill', p_symbol, 'buy', p_qty, p_fill_price, p_total_cost, p_price_source,
    p_price_retrieved_at, p_bid, p_ask, p_spread, p_signal_id,
    p_analyst_score, p_strategy_id, p_notes, p_market,
    p_expected_price, v_realized_slip, 'filled'
  ) returning id into v_event_id;

  insert into paper_trades (
    symbol, order_side, qty, fill_price, signal_id, analyst_score, direction,
    rationale, price_source, price_retrieved_at, spread_applied, paper_event_id,
    market, currency,
    data_confidence, quality_status, tainted, taint_reason,
    excluded_from_learning,
    expected_price, realized_slip_pct, fill_status
  ) values (
    p_symbol, 'buy', p_qty, p_fill_price, p_signal_id, p_analyst_score, 'long',
    p_rationale, p_price_source, p_price_retrieved_at, p_spread, v_event_id,
    p_market, p_currency,
    v_data_confidence, coalesce(v_quality_status, 'unknown'), v_tainted, v_taint_reason,
    v_tainted,
    p_expected_price, v_realized_slip, 'filled'
  ) returning id into v_trade_id;

  select id, qty, avg_cost into v_existing_id, v_existing_qty, v_existing_avg
    from paper_positions where symbol = p_symbol and market = p_market for update;

  if v_existing_id is not null then
    update paper_positions set
      qty = v_existing_qty + p_qty,
      avg_cost = ((v_existing_qty * v_existing_avg) + p_total_cost) / (v_existing_qty + p_qty),
      current_price = p_fill_price,
      updated_at = now()
    where id = v_existing_id;
  else
    insert into paper_positions (
      symbol, qty, avg_cost, current_price, price_target, stop_loss,
      highest_price, sector, market, currency
    ) values (
      p_symbol, p_qty, p_fill_price, p_fill_price, p_price_target, p_stop_loss,
      p_fill_price, p_sector, p_market, p_currency
    );
  end if;

  update paper_portfolio set
    cash_balance = cash_balance - p_total_cost,
    total_invested = coalesce(total_invested, 0) + p_total_cost,
    updated_at = now()
  where id = v_pool_id;

  return jsonb_build_object(
    'ok', true, 'trade_id', v_trade_id, 'event_id', v_event_id,
    'new_cash_balance', v_cash - p_total_cost,
    'data_confidence', v_data_confidence,
    'tainted', v_tainted,
    'expected_price', p_expected_price,
    'realized_slip_pct', v_realized_slip
  );
end;
$function$;
