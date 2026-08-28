-- Corrects the partial-exit stop precedence introduced by
-- 20260827225710_paper_exit_capture_stop_and_target.sql.
--
-- That migration wrote the residual lot's stop as
--   coalesce(v_lot.stop_loss, p_partial_stop_loss, v_pos.stop_loss)
-- so a lot that ALREADY carries a stop wins over the caller's new one. That is
-- precisely the second-partial-exit case: the residual lot produced by the
-- first partial exit has a stop, so every subsequent p_partial_stop_loss was
-- silently discarded and the lot kept re-applying a stale level -- while the
-- surviving paper_positions row DID take the new stop, so the two disagreed.
--
-- The original verification exercised only a FULL exit, which is why it could
-- not catch this. scripts/sql/test-execute-paper-exit.sql CASE 3 now covers it
-- and was mutation-verified: restoring the old ordering makes CASE 3 fail.
--
-- Applied as a targeted rewrite of the stored function body rather than a
-- retyped definition, so no unrelated line could drift during transcription.
-- Fails loudly rather than guessing if the expected text is absent.

DO $mig$
DECLARE
  v_src text;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_src
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.proname = 'execute_paper_exit';

  IF v_src IS NULL THEN
    RAISE EXCEPTION 'execute_paper_exit not found';
  END IF;

  -- Already corrected (e.g. re-run): nothing to do.
  IF position('coalesce(p_partial_stop_loss, v_lot.stop_loss, v_pos.stop_loss)' in v_src) > 0 THEN
    RETURN;
  END IF;

  IF position('coalesce(v_lot.stop_loss, p_partial_stop_loss, v_pos.stop_loss)' in v_src) = 0 THEN
    RAISE EXCEPTION 'expected partial-stop expression not found; aborting rather than guessing';
  END IF;

  EXECUTE replace(
    v_src,
    'coalesce(v_lot.stop_loss, p_partial_stop_loss, v_pos.stop_loss)',
    'coalesce(p_partial_stop_loss, v_lot.stop_loss, v_pos.stop_loss)'
  );
END
$mig$;
