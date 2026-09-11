-- Rolled-back production-safe verification for migrations
-- 20260911153405 and 20260911194022. Run after both migrations are applied.

begin;

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

do $partial_test$
declare
  v_position_id uuid := gen_random_uuid();
  v_lot_id uuid := gen_random_uuid();
  v_result jsonb;
  v_closed_high numeric;
  v_residual_high numeric;
begin
  insert into public.paper_trades
    (id, symbol, order_side, qty, fill_price, market, currency, executed_at,
     position_role, learning_scope, partial_exit_lot)
  values
    (v_lot_id, 'ZZTEST_HIGH_PARTIAL', 'buy', 2, 100, 'us', 'USD', now(),
     'alpha', 'full', false);
  insert into public.paper_positions
    (id, symbol, market, currency, qty, avg_cost, current_price, stop_loss,
     price_target, highest_price, opened_at, position_role)
  values
    (v_position_id, 'ZZTEST_HIGH_PARTIAL', 'us', 'USD', 2, 100, 110, 93, 120,
     126, now(), 'alpha');

  v_result := public.execute_paper_exit(v_position_id, 110, 'test_partial_high_water', 1, 100);
  if v_result->>'ok' <> 'true' then raise exception 'partial high-water RPC failed: %', v_result; end if;
  select highest_price into v_closed_high from public.paper_trades where id = v_lot_id;
  select highest_price into v_residual_high from public.paper_trades
    where symbol = 'ZZTEST_HIGH_PARTIAL' and closed_at is null and partial_exit_lot = true;
  if v_closed_high is distinct from 126 or v_residual_high is distinct from 126 then
    raise exception 'partial high-water expected closed/residual 126, got %/%', v_closed_high, v_residual_high;
  end if;

  v_result := public.execute_paper_exit(v_position_id, 111, 'test_residual_high_water');
  if v_result->>'ok' <> 'true' then raise exception 'residual close RPC failed: %', v_result; end if;
  if exists (select 1 from public.paper_trades where symbol = 'ZZTEST_HIGH_PARTIAL' and highest_price is distinct from 126) then
    raise exception 'final residual close lost the 126 high-water';
  end if;
end
$partial_test$;

rollback;
