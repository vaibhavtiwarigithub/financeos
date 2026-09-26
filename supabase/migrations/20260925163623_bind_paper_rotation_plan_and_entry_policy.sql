-- Remote version 20260925163623; applied through Supabase MCP.
-- Tighten the existing atomic paper-only RPC without changing its signature.
-- Old callers fail closed; no flags, positions, scores or thresholds are changed.
begin;
do $migration$
declare
  signature regprocedure := to_regprocedure('public.execute_paper_rotation(text,text,uuid,text,uuid,numeric,numeric,numeric,numeric,text,numeric,numeric,numeric,text,uuid,jsonb)');
  definition text;
  anchor text := '  v_exit_price := round(coalesce(v_src.current_price, v_src.avg_cost) * 0.9995, 4);';
  fill_anchor text := '    p_expected_price => p_candidate_fill_price';
begin
  if signature is null then raise exception 'execute_paper_rotation signature missing'; end if;
  definition := pg_get_functiondef(signature);
  if position('rotation_plan_contract_v1' in definition) > 0 then return; end if;
  if array_length(string_to_array(definition, anchor), 1) <> 2
    or array_length(string_to_array(definition, fill_anchor), 1) <> 2 then
    raise exception 'rotation function changed; review exact source before patching';
  end if;
  definition := replace(definition, anchor, $guard$
  -- rotation_plan_contract_v1: bind checked evidence under the source row lock.
  if p_gate_json is null
    or (p_gate_json #>> '{p1_readiness,ready}')::boolean is distinct from true
    or (p_gate_json #>> '{p1_plan,sourceId}')::uuid is distinct from v_src.id
    or (p_gate_json #>> '{p1_plan,candidateSignalId}')::uuid is distinct from p_candidate_signal_id
    or (p_gate_json #>> '{p1_plan,sourceQty}')::numeric is distinct from v_src.qty
    or (p_gate_json #>> '{p1_plan,sourcePrice}')::numeric is distinct from v_src.current_price
    or (p_gate_json #>> '{p1_plan,buyNotional}')::numeric is null
    or abs((p_gate_json #>> '{p1_plan,buyNotional}')::numeric - p_candidate_qty * p_candidate_fill_price) > 0.000001
    or (p_gate_json->>'p1_evaluated_at')::timestamptz is null
    or (p_gate_json->>'p1_evaluated_at')::timestamptz > clock_timestamp()
    or (p_gate_json->>'p1_evaluated_at')::timestamptz < clock_timestamp() - interval '60 seconds'
    or coalesce((p_gate_json #>> '{entry_policy,maxOpenNames}')::integer, 0) < 1
    or coalesce((p_gate_json #>> '{entry_policy,maxSectorNames}')::integer, 0) < 1
    or coalesce((p_gate_json #>> '{entry_policy,horizonDays}')::integer, 0) < 1
    or (p_gate_json #>> '{entry_policy,dayStart}')::timestamptz is null then
    return jsonb_build_object('ok', false, 'error', 'rotation_plan_contract_invalid');
  end if;
  if v_src.exit_reason is not null or v_src.current_price is null
    or v_src.current_price <= 0 or v_src.qty <= 0
    or v_src.current_price <= v_src.stop_loss
    or v_src.current_price >= v_src.price_target then
    return jsonb_build_object('ok', false, 'error', 'rotation_source_exit_due_or_unpriced');
  end if;
  v_exit_price := round(v_src.current_price * 0.9995, 4);$guard$);
  definition := replace(definition, fill_anchor, $fill$
    p_expected_price => p_candidate_fill_price,
    p_mandate_id => (p_gate_json #>> '{entry_policy,mandateId}')::uuid,
    p_mandate_version => (p_gate_json #>> '{entry_policy,mandateVersion}')::integer,
    p_mandate_snapshot => p_gate_json #> '{entry_policy,mandateSnapshot}',
    p_resolved_horizon_days => (p_gate_json #>> '{entry_policy,horizonDays}')::integer,
    p_max_open_names => (p_gate_json #>> '{entry_policy,maxOpenNames}')::integer,
    p_max_sector_names => (p_gate_json #>> '{entry_policy,maxSectorNames}')::integer,
    p_per_trade_cap => (p_gate_json #>> '{entry_policy,perTradeCap}')::numeric,
    p_daily_notional_cap => (p_gate_json #>> '{entry_policy,dailyNotionalCap}')::numeric,
    p_day_start => (p_gate_json #>> '{entry_policy,dayStart}')::timestamptz$fill$);
  execute definition;
end;
$migration$;
commit;
