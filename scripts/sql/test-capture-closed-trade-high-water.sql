-- Rolled-back production-safe verification for migration
-- 20260911153405_capture_closed_trade_high_water.sql.
-- This file deliberately repeats the guarded migration body because the
-- Management API SQL runner does not support psql \ir includes.

begin;

do $migration$
declare
  v_signature regprocedure := to_regprocedure('public.execute_paper_exit(uuid,numeric,text,numeric,numeric)');
  v_source text;
  v_full_old text := 'take_profit = coalesce(take_profit, v_pos.price_target),' || chr(10) ||
    '        closed_at = v_now, exit_at = v_now';
  v_full_new text := 'take_profit = coalesce(take_profit, v_pos.price_target),' || chr(10) ||
    '        highest_price = greatest(coalesce(highest_price, v_pos.highest_price, p_exit_price),' || chr(10) ||
    '          coalesce(v_pos.highest_price, p_exit_price), p_exit_price),' || chr(10) ||
    '        closed_at = v_now, exit_at = v_now';
  v_residual_old text := 'coalesce(v_lot.take_profit, v_pos.price_target), v_lot.highest_price,';
  v_residual_new text := 'coalesce(v_lot.take_profit, v_pos.price_target),' || chr(10) ||
    '        greatest(coalesce(v_lot.highest_price, v_pos.highest_price, p_exit_price),' || chr(10) ||
    '          coalesce(v_pos.highest_price, p_exit_price), p_exit_price),';
begin
  select pg_get_functiondef(v_signature) into v_source;
  if v_signature is null or v_source is null then
    raise exception 'execute_paper_exit is missing';
  end if;
  if (length(v_source) - length(replace(v_source, v_full_old, ''))) /
      nullif(length(v_full_old), 0) <> 2 then
    raise exception 'close branches do not match expected high-water patch shape';
  end if;
  if position(v_residual_old in v_source) = 0 then
    raise exception 'residual branch does not match expected high-water patch shape';
  end if;
  execute replace(replace(v_source, v_full_old, v_full_new), v_residual_old, v_residual_new);
end
$migration$;

do $test$
declare
  v_position_id uuid := gen_random_uuid();
  v_lot_id uuid := gen_random_uuid();
  v_result jsonb;
  v_high numeric;
begin
  insert into public.paper_trades
    (id, symbol, order_side, qty, fill_price, market, currency, executed_at,
     position_role, learning_scope, partial_exit_lot)
  values
    (v_lot_id, 'ZZTEST_HIGH_WATER', 'buy', 2, 100, 'us', 'USD', now(),
     'alpha', 'full', false);

  insert into public.paper_positions
    (id, symbol, market, currency, qty, avg_cost, current_price, stop_loss,
     price_target, highest_price, opened_at, position_role)
  values
    (v_position_id, 'ZZTEST_HIGH_WATER', 'us', 'USD', 2, 100, 110, 93, 120,
     126, now(), 'alpha');

  v_result := public.execute_paper_exit(v_position_id, 110, 'test_high_water');
  if v_result->>'ok' <> 'true' then
    raise exception 'high-water test RPC failed: %', v_result;
  end if;

  select highest_price into v_high from public.paper_trades where id = v_lot_id;
  if v_high is distinct from 126 then
    raise exception 'highest_price expected 126, got %', v_high;
  end if;
end
$test$;

rollback;
