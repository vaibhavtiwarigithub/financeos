-- Enable capital rotation PAPER execution (both markets). Live books stay locked.
--
-- Replaces the P0 containment stub of execute_paper_rotation (which always
-- returned p1_guardrails_incomplete and wrote nothing) with a real atomic
-- implementation that composes the two battle-tested paper primitives:
--   1. execute_paper_exit  — sells the source position at its marked price
--   2. execute_paper_fill  — buys the candidate, re-validating EVERY entry
--      gate (signal claim ownership, mandate threshold, market controls,
--      pyramid gate, name/sector caps, cash) inside the same transaction
-- If the buy leg fails for any reason the whole transaction rolls back —
-- the source position is never sold without the candidate being bought.
--
-- Also flips rotation_config.rotation_paper_execute_enabled = true for
-- book_type='paper' rows only. The TS caller still requires the
-- CAPITAL_ROTATION_PAPER_ENABLED deployment env var, and re-runs the full
-- deterministic eligibility eval + persistence/cooldown/daily-cap gates
-- before calling this RPC. rotation_events stays append-only.

create or replace function public.execute_paper_rotation(
  p_market text,
  p_currency text,
  p_source_position_id uuid,
  p_candidate_symbol text,
  p_candidate_signal_id uuid,
  p_candidate_qty numeric,
  p_candidate_fill_price numeric,
  p_candidate_price_target numeric,
  p_candidate_stop_loss numeric,
  p_candidate_sector text,
  p_candidate_score numeric,
  p_source_score numeric,
  p_score_edge numeric,
  p_idempotency_key text,
  p_claim_run_id uuid,
  p_gate_json jsonb
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_execute_enabled boolean;
  v_src public.paper_positions%rowtype;
  v_exit_price numeric;
  v_exit jsonb;
  v_fill jsonb;
  v_sell_notional numeric;
  v_buy_notional numeric;
begin
  -- Input + claim validation (preserved from the containment stub).
  if p_market not in ('us', 'india') or p_claim_run_id is null then
    return jsonb_build_object('ok', false, 'error', 'invalid_rotation_claim');
  end if;
  if (p_market = 'india' and p_currency is distinct from 'INR')
     or (p_market = 'us' and p_currency is distinct from 'USD') then
    return jsonb_build_object('ok', false, 'error', 'invalid_rotation_claim');
  end if;
  if not exists (
    select 1 from public.agent_signals
    where id = p_candidate_signal_id
      and market = p_market
      and status = 'claiming'
      and claim_run_id = p_claim_run_id
  ) then
    return jsonb_build_object('ok', false, 'error', 'signal_claim_not_owned');
  end if;
  if p_candidate_qty is null or p_candidate_qty <= 0
     or p_candidate_fill_price is null or p_candidate_fill_price <= 0 then
    return jsonb_build_object('ok', false, 'error', 'invalid_rotation_input');
  end if;

  -- Defense in depth: DB-side master flag, paper book only.
  select rotation_paper_execute_enabled into v_execute_enabled
    from public.rotation_config
    where market = p_market and book_type = 'paper';
  if v_execute_enabled is distinct from true then
    return jsonb_build_object('ok', false, 'error', 'execute_disabled');
  end if;

  -- Idempotency: same key already executed → no-op replay.
  if exists (select 1 from public.rotation_events where idempotency_key = p_idempotency_key) then
    return jsonb_build_object('ok', false, 'error', 'duplicate_rotation');
  end if;

  -- Lock and validate the source position.
  select * into v_src from public.paper_positions
    where id = p_source_position_id for update;
  if not found then
    return jsonb_build_object('ok', false, 'error', 'source_position_not_found');
  end if;
  if v_src.market <> p_market or coalesce(v_src.position_role, 'alpha') <> 'alpha' then
    return jsonb_build_object('ok', false, 'error', 'source_position_invalid');
  end if;
  if upper(v_src.symbol) = upper(p_candidate_symbol) then
    return jsonb_build_object('ok', false, 'error', 'source_is_candidate');
  end if;

  -- SELL leg: exit source at its monitor-marked price with a 5 bps slippage
  -- haircut (matches the shadow cost model's slippage_bps_per_leg: 5).
  v_exit_price := round(coalesce(v_src.current_price, v_src.avg_cost) * 0.9995, 4);
  if v_exit_price is null or v_exit_price <= 0 then
    return jsonb_build_object('ok', false, 'error', 'source_price_unavailable');
  end if;
  v_exit := public.execute_paper_exit(
    p_position_id => p_source_position_id,
    p_exit_price  => v_exit_price,
    p_exit_reason => 'capital_rotation'
  );
  if coalesce((v_exit->>'ok')::boolean, false) is not true then
    return jsonb_build_object('ok', false, 'error', 'exit_failed:' || coalesce(v_exit->>'error', 'unknown'));
  end if;
  v_sell_notional := (v_exit->>'proceeds')::numeric;

  -- BUY leg: full entry-gate revalidation. Any denial aborts the whole
  -- rotation (raise → transaction rollback un-sells the source).
  v_buy_notional := p_candidate_qty * p_candidate_fill_price;
  v_fill := public.execute_paper_fill(
    p_signal_id  => p_candidate_signal_id,
    p_market     => p_market,
    p_currency   => p_currency,
    p_symbol     => p_candidate_symbol,
    p_qty        => p_candidate_qty,
    p_fill_price => p_candidate_fill_price,
    p_total_cost => v_buy_notional,
    p_price_source => 'capital_rotation',
    p_price_retrieved_at => now(),
    p_bid => null, p_ask => null, p_spread => null,
    p_analyst_score => p_candidate_score,
    p_strategy_id => 'capital_rotation',
    p_notes => format('rotation: sold %s (score %s) to fund %s (score %s), edge %s',
                      v_src.symbol, p_source_score, p_candidate_symbol, p_candidate_score, p_score_edge),
    p_rationale => format('Capital rotation: replaced %s with %s (score edge %s)',
                          v_src.symbol, p_candidate_symbol, p_score_edge),
    p_price_target => p_candidate_price_target,
    p_stop_loss => p_candidate_stop_loss,
    p_sector => p_candidate_sector,
    p_expected_price => p_candidate_fill_price
  );
  if coalesce((v_fill->>'ok')::boolean, false) is not true then
    raise exception 'rotation buy leg denied: %', coalesce(v_fill->>'error', 'unknown')
      using errcode = 'P0001';
  end if;

  -- Audit event (append-only table; INSERT allowed, UPDATE/DELETE blocked).
  insert into public.rotation_events (
    market, currency, book_type, idempotency_key, status,
    candidate_symbol, source_symbol, candidate_signal_id, source_position_id,
    candidate_score, source_score, score_edge,
    sell_notional, buy_notional, turnover_consumed,
    cost_model_json, gate_results_json, audit_json
  ) values (
    p_market, p_currency, 'paper', p_idempotency_key, 'paper_executed',
    p_candidate_symbol, v_src.symbol, p_candidate_signal_id, p_source_position_id,
    p_candidate_score, p_source_score, p_score_edge,
    v_sell_notional, v_buy_notional, v_sell_notional + v_buy_notional,
    jsonb_build_object('phase', 'p1_paper', 'slippage_bps_per_leg', 5, 'exit_price', v_exit_price),
    p_gate_json,
    jsonb_build_object(
      'run_id', p_claim_run_id,
      'source_realized_pnl', (v_exit->>'realized_pnl')::numeric,
      'buy_trade_id', v_fill->>'trade_id'
    )
  );

  return jsonb_build_object(
    'ok', true,
    'source_symbol', v_src.symbol,
    'candidate_symbol', p_candidate_symbol,
    'sell_notional', v_sell_notional,
    'buy_notional', v_buy_notional,
    'source_realized_pnl', (v_exit->>'realized_pnl')::numeric,
    'buy_trade_id', v_fill->>'trade_id'
  );
exception
  when unique_violation then
    return jsonb_build_object('ok', false, 'error', 'duplicate_rotation');
end;
$$;

revoke all on function public.execute_paper_rotation(text, text, uuid, text, uuid, numeric, numeric, numeric, numeric, text, numeric, numeric, numeric, text, uuid, jsonb) from public, anon, authenticated;
grant execute on function public.execute_paper_rotation(text, text, uuid, text, uuid, numeric, numeric, numeric, numeric, text, numeric, numeric, numeric, text, uuid, jsonb) to service_role;

-- P1 approved for PAPER (owner instruction 2026-07-23): drop the containment
-- check that pinned rotation_paper_execute_enabled=false. Live rotation stays
-- structurally impossible — no live rotation code path exists.
alter table public.rotation_config drop constraint if exists rotation_paper_execution_p1_not_approved;

-- Master DB flag: PAPER books only. Live rows remain false.
update public.rotation_config
  set rotation_paper_execute_enabled = true
  where book_type = 'paper';

-- Intraday adaptation: second research+fill cycle per market so afternoon
-- rips get rescored and can rotate in before the close.
-- US: research 18:00 UTC (14:00 ET), fill 19:15 UTC (15:15 ET).
-- India: research 07:00 UTC (12:30 IST), fill 07:45 UTC (13:15 IST).
select cron.schedule('kairos-research-us-pm', '0 18 * * 1-5',
  'select kairos_call_agent(''/api/agents/research/cron?market=us'', ''{}''::jsonb, ''POST'', 160000)');
select cron.schedule('kairos-paper-trade-us-pm', '15 19 * * 1-5',
  'select public.kairos_call_agent(''/api/agents/paper-trade?market=us'', ''{}''::jsonb, ''POST'', 120000)');
select cron.schedule('kairos-research-india-mid', '0 7 * * 1-5',
  'select kairos_call_agent(''/api/agents/research/cron?market=india'', ''{}''::jsonb, ''POST'', 160000)');
select cron.schedule('kairos-paper-trade-india-mid', '45 7 * * 1-5',
  'select public.kairos_call_agent(''/api/agents/paper-trade?market=india'', ''{}''::jsonb, ''POST'', 120000)');
