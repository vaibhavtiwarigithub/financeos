-- Regression test for public.execute_paper_exit.
--
-- Run against any environment. It ALWAYS ends by raising, so every row it
-- creates is rolled back and nothing is left behind:
--   psql "$SUPABASE_DB_URL" -f scripts/sql/test-execute-paper-exit.sql
-- A pass looks like:  ERROR:  ALL_TESTS_PASSED ...
-- Any other ERROR is a real failure.
--
-- Covers the defect fixed on 2026-08-27 (the closing UPDATE discarded the
-- position's stop_loss/price_target before deleting the position row) AND the
-- partial-exit precedence bug that the original full-exit-only test could not
-- catch: a residual lot already carries a stop, so `coalesce` had to put the
-- caller's NEW p_partial_stop_loss first or a second partial exit would keep
-- re-applying the stale level.
--
-- NOTE: paper_trades must be inserted BEFORE paper_positions; the
-- prevent_paper_alpha_pyramid trigger rejects a new alpha lot while an open
-- position for the symbol exists.

DO $test$
DECLARE
  v_pos_id uuid; v_lot_id uuid; v_res jsonb;
  v_stop numeric; v_tp numeric; v_qty numeric;
  v_resid_stop numeric; v_resid_qty numeric;
  v_sym text;
BEGIN
  -- ── CASE 1: full exit captures the position's levels ──────────────────────
  v_sym := 'ZZTEST_FULL'; v_pos_id := gen_random_uuid(); v_lot_id := gen_random_uuid();

  INSERT INTO public.paper_trades
    (id, symbol, order_side, qty, fill_price, market, currency, executed_at,
     position_role, learning_scope, partial_exit_lot)
  VALUES (v_lot_id, v_sym, 'buy', 10, 100, 'us', 'USD', now(), 'alpha', 'full', false);

  INSERT INTO public.paper_positions
    (id, symbol, market, currency, qty, avg_cost, current_price,
     stop_loss, price_target, opened_at, position_role)
  VALUES (v_pos_id, v_sym, 'us', 'USD', 10, 100, 105, 93.00, 120.00, now(), 'alpha');

  v_res := public.execute_paper_exit(v_pos_id, 110.0, 'test_full_exit');
  IF v_res->>'ok' <> 'true' THEN RAISE EXCEPTION 'CASE1 rpc failed: %', v_res; END IF;

  SELECT stop_loss, take_profit INTO v_stop, v_tp
  FROM public.paper_trades WHERE id = v_lot_id;
  IF v_stop IS DISTINCT FROM 93.00 THEN
    RAISE EXCEPTION 'CASE1 FAIL: stop_loss not captured (got %)', v_stop; END IF;
  IF v_tp IS DISTINCT FROM 120.00 THEN
    RAISE EXCEPTION 'CASE1 FAIL: take_profit not captured (got %)', v_tp; END IF;
  IF EXISTS (SELECT 1 FROM public.paper_positions WHERE id = v_pos_id) THEN
    RAISE EXCEPTION 'CASE1 FAIL: fully-closed position was not deleted'; END IF;

  -- ── CASE 2: partial exit, lot has NO prior stop ───────────────────────────
  -- Closed portion captures the position level; residual takes the new partial stop.
  v_sym := 'ZZTEST_PART1'; v_pos_id := gen_random_uuid(); v_lot_id := gen_random_uuid();

  INSERT INTO public.paper_trades
    (id, symbol, order_side, qty, fill_price, market, currency, executed_at,
     position_role, learning_scope, partial_exit_lot)
  VALUES (v_lot_id, v_sym, 'buy', 10, 100, 'us', 'USD', now(), 'alpha', 'full', false);

  INSERT INTO public.paper_positions
    (id, symbol, market, currency, qty, avg_cost, current_price,
     stop_loss, price_target, opened_at, position_role)
  VALUES (v_pos_id, v_sym, 'us', 'USD', 10, 100, 130, 93.00, 120.00, now(), 'alpha');

  v_res := public.execute_paper_exit(v_pos_id, 130.0, 'test_partial', 4, 115.00);
  IF v_res->>'ok' <> 'true' THEN RAISE EXCEPTION 'CASE2 rpc failed: %', v_res; END IF;

  SELECT stop_loss, take_profit, qty INTO v_stop, v_tp, v_qty
  FROM public.paper_trades WHERE id = v_lot_id;
  IF v_qty IS DISTINCT FROM 4 THEN
    RAISE EXCEPTION 'CASE2 FAIL: closed lot qty expected 4, got %', v_qty; END IF;
  IF v_stop IS DISTINCT FROM 93.00 THEN
    RAISE EXCEPTION 'CASE2 FAIL: closed portion stop expected 93.00, got %', v_stop; END IF;

  SELECT stop_loss, qty INTO v_resid_stop, v_resid_qty
  FROM public.paper_trades
  WHERE symbol = v_sym AND closed_at IS NULL AND partial_exit_lot = true;
  IF v_resid_qty IS DISTINCT FROM 6 THEN
    RAISE EXCEPTION 'CASE2 FAIL: residual qty expected 6, got %', v_resid_qty; END IF;
  IF v_resid_stop IS DISTINCT FROM 115.00 THEN
    RAISE EXCEPTION 'CASE2 FAIL: residual should take the NEW partial stop 115.00, got %', v_resid_stop; END IF;

  -- ── CASE 3: THE REGRESSION. Lot already carries a stop; a new partial stop
  -- must still win. Under the original coalesce(v_lot.stop_loss, ...) ordering
  -- the residual kept the stale 90.00 and the caller's 118.00 was silently
  -- discarded -- exactly what happens on a SECOND partial exit, because the
  -- residual lot from the first one already has a stop.
  v_sym := 'ZZTEST_PART2'; v_pos_id := gen_random_uuid(); v_lot_id := gen_random_uuid();

  INSERT INTO public.paper_trades
    (id, symbol, order_side, qty, fill_price, market, currency, executed_at,
     position_role, learning_scope, partial_exit_lot, stop_loss)
  VALUES (v_lot_id, v_sym, 'buy', 10, 100, 'us', 'USD', now(), 'alpha', 'full', false, 90.00);

  INSERT INTO public.paper_positions
    (id, symbol, market, currency, qty, avg_cost, current_price,
     stop_loss, price_target, opened_at, position_role)
  VALUES (v_pos_id, v_sym, 'us', 'USD', 10, 100, 130, 93.00, 120.00, now(), 'alpha');

  v_res := public.execute_paper_exit(v_pos_id, 130.0, 'test_partial_2', 3, 118.00);
  IF v_res->>'ok' <> 'true' THEN RAISE EXCEPTION 'CASE3 rpc failed: %', v_res; END IF;

  -- The lot's own pre-existing stop must NOT be overwritten on the closed leg.
  SELECT stop_loss INTO v_stop FROM public.paper_trades WHERE id = v_lot_id;
  IF v_stop IS DISTINCT FROM 90.00 THEN
    RAISE EXCEPTION 'CASE3 FAIL: existing lot stop must be preserved, got %', v_stop; END IF;

  SELECT stop_loss INTO v_resid_stop FROM public.paper_trades
  WHERE symbol = v_sym AND closed_at IS NULL AND partial_exit_lot = true;
  IF v_resid_stop IS DISTINCT FROM 118.00 THEN
    RAISE EXCEPTION 'CASE3 FAIL: new partial stop must win over the lot''s stale 90.00, got %', v_resid_stop; END IF;

  RAISE EXCEPTION 'ALL_TESTS_PASSED (3 cases; this abort is intentional and rolls everything back)';
END
$test$;
