-- Bind atomic paper-rotation execution to the exact constructor-sized quantity.
-- Apply only after the matching PaperTrader caller is deployed.
begin;

do $migration$
declare
  signature regprocedure := to_regprocedure(
    'public.execute_paper_rotation(text,text,uuid,text,uuid,numeric,numeric,numeric,numeric,text,numeric,numeric,numeric,text,uuid,jsonb)'
  );
  definition text;
  plan_anchor text := $anchor$    or abs((p_gate_json #>> '{p1_plan,buyNotional}')::numeric - p_candidate_qty * p_candidate_fill_price) > 0.000001$anchor$;
  plan_replacement text := $replacement$    -- rotation_fractional_qty_contract_v1: bind shares as well as dollars.
    or abs((p_gate_json #>> '{p1_plan,buyNotional}')::numeric - p_candidate_qty * p_candidate_fill_price) > 0.000001
    or (p_gate_json #>> '{p1_plan,candidateQty}')::numeric is distinct from p_candidate_qty$replacement$;
  ledger_anchor text := $anchor$      and abs(e.buy_notional - p_candidate_qty * p_candidate_fill_price) <= 0.000001$anchor$;
  ledger_replacement text := $replacement$      and abs(e.buy_notional - p_candidate_qty * p_candidate_fill_price) <= 0.000001
      and (e.audit_json #>> '{p1_plan,candidateQty}')::numeric is not distinct from p_candidate_qty$replacement$;
  required_marker text := 'rotation_ledger_binding_v1';
begin
  if signature is null then
    raise exception 'execute_paper_rotation signature missing';
  end if;

  definition := pg_get_functiondef(signature);
  if position('rotation_fractional_qty_contract_v1' in definition) > 0 then
    return;
  end if;
  if position(required_marker in definition) = 0 then
    raise exception 'rotation ledger binding is missing; refusing to patch a different RPC contract';
  end if;
  if array_length(string_to_array(definition, plan_anchor), 1) <> 2
     or array_length(string_to_array(definition, ledger_anchor), 1) <> 2 then
    raise exception 'rotation quantity anchors changed; inspect exact function source before patching';
  end if;

  definition := replace(definition, plan_anchor, plan_replacement);
  definition := replace(definition, ledger_anchor, ledger_replacement);
  execute definition;
end;
$migration$;

commit;
