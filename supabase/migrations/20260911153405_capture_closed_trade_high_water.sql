-- Preserve the position high-water mark on every closed paper lot.
--
-- paper_positions.highest_price is updated while the position is open, but the
-- exit RPC historically deleted that row without copying the value to the
-- closed paper_trades lot. This guarded source rewrite keeps the correction
-- atomic with the existing exit transaction and refuses to guess if the active
-- function no longer has the expected shape.

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
  if v_signature is null then
    raise exception 'execute_paper_exit(uuid,numeric,text,numeric,numeric) is missing';
  end if;

  select pg_get_functiondef(v_signature) into v_source;

  if position('highest_price = greatest(coalesce(highest_price, v_pos.highest_price, p_exit_price)' in v_source) > 0 then
    return;
  end if;

  -- The full- and partial-close UPDATE branches share this exact fragment and
  -- must both be patched. Refuse a partial migration if that invariant changes.
  if (length(v_source) - length(replace(v_source, v_full_old, ''))) /
      nullif(length(v_full_old), 0) <> 2 then
    raise exception 'execute_paper_exit close branches do not match expected high-water patch shape';
  end if;
  if position(v_residual_old in v_source) = 0 then
    raise exception 'execute_paper_exit residual-lot branch does not match expected high-water patch shape';
  end if;

  v_source := replace(v_source, v_full_old, v_full_new);
  v_source := replace(v_source, v_residual_old, v_residual_new);
  execute v_source;
end
$migration$;

comment on column public.paper_trades.highest_price is
  'Maximum verified position price observed while this lot was open; copied atomically from paper_positions at exit. Historical NULL rows are not reconstructed.';
