-- Learning Integrity Phase 1B: wire taint columns into execute_paper_fill.
-- The function now joins v_decision_quality by signal_id and stamps the five
-- quality fields on the paper_trades row at fill time. This is measure-only:
-- tainted=true is written to the row but does NOT block the fill or any
-- downstream path. Enforcement (excluding tainted rows from learner queries)
-- ships as a separate filter change after golden-test validation.
--
-- TAINT RULE (measure-only):
--   quality_status = 'ok'  AND data_confidence < 0.5 -> tainted=true
--   quality_status = 'unknown' OR data_confidence IS NULL -> tainted=false (not assumed bad)

create or replace function execute_paper_fill(
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
  p_sector text
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
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
  -- Taint fields from v_decision_quality
  v_data_confidence   numeric;
  v_quality_status    text;
  v_tainted           boolean;
  v_taint_reason      text;
  v_missing_dims      text[];
  v_degraded_dims     text[];
begin
  -- Lock the pool row for this market to serialize concurrent fills against it.
  select id, cash_balance, coalesce(total_invested, 0)
    into v_pool_id, v_cash, v_total_invested
    from paper_portfolio where market = p_market for update;

  if v_pool_id is null then
    return jsonb_build_object('ok', false, 'error', 'pool_not_found');
  end if;
  if p_total_cost > v_cash then
    return jsonb_build_object('ok', false, 'error', 'insufficient_cash');
  end if;

  -- Re-verify the signal is still exactly where JS left it (claiming) before
  -- committing any money movement. If this fails, the whole transaction (and
  -- every write below) rolls back automatically.
  update agent_signals set status = 'paper_traded'
    where id = p_signal_id and status = 'claiming'
    returning id into v_updated_signal;
  if v_updated_signal is null then
    return jsonb_build_object('ok', false, 'error', 'signal_not_claiming');
  end if;

  -- Read data quality from the view (measure-only; never blocks the fill).
  select dq.data_confidence, dq.quality_status, dq.missing_dims, dq.degraded_dims
    into v_data_confidence, v_quality_status, v_missing_dims, v_degraded_dims
    from v_decision_quality dq
    where dq.signal_id = p_signal_id
    limit 1;

  -- Compute taint: only flag when we have a definitive quality_status='ok'
  -- and data_confidence is below the threshold. unknown quality = measure silently.
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
    analyst_score, strategy_id, notes, market
  ) values (
    'fill', p_symbol, 'buy', p_qty, p_fill_price, p_total_cost, p_price_source,
    p_price_retrieved_at, p_bid, p_ask, p_spread, p_signal_id,
    p_analyst_score, p_strategy_id, p_notes, p_market
  ) returning id into v_event_id;

  insert into paper_trades (
    symbol, order_side, qty, fill_price, signal_id, analyst_score, direction,
    rationale, price_source, price_retrieved_at, spread_applied, paper_event_id,
    market, currency,
    data_confidence, quality_status, tainted, taint_reason,
    excluded_from_learning
  ) values (
    p_symbol, 'buy', p_qty, p_fill_price, p_signal_id, p_analyst_score, 'long',
    p_rationale, p_price_source, p_price_retrieved_at, p_spread, v_event_id,
    p_market, p_currency,
    v_data_confidence, coalesce(v_quality_status, 'unknown'), v_tainted, v_taint_reason,
    v_tainted  -- measure-only: excluded iff tainted (will add override path in Phase 2)
  ) returning id into v_trade_id;

  -- Lock any existing position for this symbol+market before upserting.
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
    'tainted', v_tainted
  );
end;
$$;

-- Same grants as before.
revoke all on function execute_paper_fill from public, anon, authenticated;
grant execute on function execute_paper_fill to service_role;
