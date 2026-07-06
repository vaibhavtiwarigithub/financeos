-- P0 improvement: transactional paper fill. Today's PaperTrader does claim ->
-- event insert -> trade insert -> position upsert -> cash debit -> signal flip
-- as separate, individually-committed writes. A crash/error mid-sequence can
-- leave partial state (e.g. an orphan paper_order_events row with no matching
-- trade). This RPC wraps the money-moving writes in ONE transaction with
-- row-level locking on the pool (and the position, if it exists) so a fill
-- either fully lands or fully rolls back. Schema verified live via Supabase
-- MCP before writing this (see Decision 34) — all id/signal_id types below
-- are confirmed, not guessed.
--
-- Signal claim (pending->claiming) still happens in JS BEFORE calling this
-- (unchanged) — this function only re-verifies + flips claiming->paper_traded
-- as part of its own transaction, aborting (and rolling back every write) if
-- the signal isn't in 'claiming' state when it runs.

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
    market, currency
  ) values (
    p_symbol, 'buy', p_qty, p_fill_price, p_signal_id, p_analyst_score, 'long',
    p_rationale, p_price_source, p_price_retrieved_at, p_spread, v_event_id,
    p_market, p_currency
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
    'new_cash_balance', v_cash - p_total_cost
  );
end;
$$;

-- Called only from the service-role server (never exposed to anon/authenticated
-- PostgREST clients — this moves money and must not be publicly callable).
revoke all on function execute_paper_fill from public, anon, authenticated;
grant execute on function execute_paper_fill to service_role;
