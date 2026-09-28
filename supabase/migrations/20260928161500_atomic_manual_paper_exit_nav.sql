-- Manual owner exits use the canonical lot/cash ledger, then restore the
-- documented NAV invariant in the same transaction. Owner-directed
-- consolidation remains real portfolio performance but is excluded from
-- signal-learning attribution; normal manual exits are not excluded.
CREATE OR REPLACE FUNCTION public.execute_paper_manual_exit(
  p_position_id uuid,
  p_exit_price numeric,
  p_exit_reason text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_result jsonb;
  v_market text;
  v_expected integer;
  v_updated integer;
BEGIN
  IF p_exit_reason NOT IN ('manual_close', 'manual_owner_consolidation_to_8') THEN
    RETURN jsonb_build_object('ok', false, 'error', 'invalid_manual_exit_reason');
  END IF;

  v_result := public.execute_paper_exit(p_position_id, p_exit_price, p_exit_reason, NULL, NULL);
  IF coalesce(v_result->>'ok', 'false') <> 'true' THEN
    RETURN v_result;
  END IF;
  v_market := v_result->>'market';

  IF p_exit_reason = 'manual_owner_consolidation_to_8' THEN
    SELECT count(*) INTO v_expected
    FROM jsonb_array_elements_text(coalesce(v_result->'closed_trade_ids', '[]'::jsonb));
    UPDATE public.paper_trades
    SET excluded_from_learning = true
    WHERE id IN (
      SELECT value::uuid
      FROM jsonb_array_elements_text(coalesce(v_result->'closed_trade_ids', '[]'::jsonb)) AS ids(value)
    ) AND closed_at IS NOT NULL AND order_side = 'buy';
    GET DIAGNOSTICS v_updated = ROW_COUNT;
    IF v_updated <> v_expected THEN
      RAISE EXCEPTION 'owner consolidation attribution mismatch: expected %, marked %', v_expected, v_updated;
    END IF;
  END IF;

  UPDATE public.paper_portfolio pool
  SET nav = pool.cash_balance + coalesce((
        SELECT sum(p.qty * coalesce(p.current_price, p.avg_cost))
        FROM public.paper_positions p WHERE p.market = v_market
      ), 0),
      updated_at = now()
  WHERE pool.market = v_market;

  RETURN v_result || jsonb_build_object(
    'excluded_from_learning', p_exit_reason = 'manual_owner_consolidation_to_8',
    'nav_reconciled', true
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.execute_paper_manual_exit(uuid, numeric, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.execute_paper_manual_exit(uuid, numeric, text) TO service_role;
