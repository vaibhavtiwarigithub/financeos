-- Owner-directed paper-book consolidation is real portfolio P&L, but it is not
-- evidence about signal quality. Close via the canonical atomic ledger and mark
-- the resulting closed lots excluded from signal-learning attribution in the
-- same transaction. NAV/performance remain untouched by the exclusion flag.
CREATE OR REPLACE FUNCTION public.execute_paper_consolidation_exit(
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
  v_expected integer;
  v_updated integer;
BEGIN
  IF p_exit_reason <> 'manual_owner_consolidation_to_8' THEN
    RETURN jsonb_build_object('ok', false, 'error', 'invalid_consolidation_exit_reason');
  END IF;

  v_result := public.execute_paper_exit(
    p_position_id, p_exit_price, p_exit_reason, NULL, NULL
  );
  IF coalesce(v_result->>'ok', 'false') <> 'true' THEN
    RETURN v_result;
  END IF;

  SELECT count(*) INTO v_expected
  FROM jsonb_array_elements_text(coalesce(v_result->'closed_trade_ids', '[]'::jsonb));

  UPDATE public.paper_trades
  SET excluded_from_learning = true
  WHERE id IN (
    SELECT value::uuid
    FROM jsonb_array_elements_text(coalesce(v_result->'closed_trade_ids', '[]'::jsonb)) AS ids(value)
  )
    AND closed_at IS NOT NULL
    AND order_side = 'buy';
  GET DIAGNOSTICS v_updated = ROW_COUNT;

  IF v_updated <> v_expected THEN
    RAISE EXCEPTION 'owner consolidation attribution mismatch: expected %, marked %', v_expected, v_updated;
  END IF;

  RETURN v_result || jsonb_build_object('excluded_from_learning', true);
END;
$function$;

REVOKE ALL ON FUNCTION public.execute_paper_consolidation_exit(uuid, numeric, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.execute_paper_consolidation_exit(uuid, numeric, text) TO service_role;
