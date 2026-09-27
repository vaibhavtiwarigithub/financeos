-- Preserve the exact risk levels supplied to the atomic paper-fill RPC on the
-- originating lot. These values are needed to replay the actual baseline exit
-- policy; writing them does not change the fill, position, stop, target, or exit.
--
-- Patch the deployed function definition instead of copying/replacing its
-- large safety-critical body. Exact fragment guards make this fail closed if
-- production's function has drifted or a prior copy already contains the fix.
do $$
declare
  v_signature regprocedure :=
    'public.execute_paper_fill(uuid,text,text,text,numeric,numeric,numeric,text,timestamptz,numeric,numeric,numeric,numeric,text,text,text,numeric,numeric,text,numeric,uuid,integer,jsonb,integer,integer,integer,numeric,numeric,timestamptz)'::regprocedure;
  v_definition text;
  v_patched text;
  v_columns text := E'    fill_status, mandate_id, mandate_version, mandate_snapshot,\n    resolved_horizon_days, position_role\n  ) values (';
  v_columns_replacement text := E'    fill_status, mandate_id, mandate_version, mandate_snapshot,\n    resolved_horizon_days, position_role, stop_loss, take_profit\n  ) values (';
  v_values text := E'    p_mandate_id, p_mandate_version, p_mandate_snapshot,\n    p_resolved_horizon_days, ''alpha''';
  v_values_replacement text := E'    p_mandate_id, p_mandate_version, p_mandate_snapshot,\n    p_resolved_horizon_days, ''alpha'', p_stop_loss, p_price_target';
begin
  v_definition := pg_get_functiondef(v_signature);

  if length(v_definition) - length(replace(v_definition, v_columns, '')) <> length(v_columns) then
    raise exception 'execute_paper_fill expected exactly one unpatched risk-level insert column fragment';
  end if;
  if length(v_definition) - length(replace(v_definition, v_values, '')) <> length(v_values) then
    raise exception 'execute_paper_fill expected exactly one unpatched risk-level insert values fragment';
  end if;

  v_patched := replace(replace(v_definition, v_columns, v_columns_replacement), v_values, v_values_replacement);
  if v_patched = v_definition
     or position('resolved_horizon_days, position_role, stop_loss, take_profit' in v_patched) = 0
     or position('p_resolved_horizon_days, ''alpha'', p_stop_loss, p_price_target' in v_patched) = 0 then
    raise exception 'execute_paper_fill risk-level patch did not produce the expected source';
  end if;

  execute v_patched;
end;
$$;

comment on column public.paper_trades.stop_loss is
  'Initial stop level supplied to execute_paper_fill at entry; exit-time capture fills legacy NULLs only.';
comment on column public.paper_trades.take_profit is
  'Initial target level supplied to execute_paper_fill at entry; exit-time capture fills legacy NULLs only.';
