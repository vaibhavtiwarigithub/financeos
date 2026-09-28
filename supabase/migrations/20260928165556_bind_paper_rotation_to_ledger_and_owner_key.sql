-- Remote version 20260928165556; applied through Supabase MCP (project dionkikgdmlaotvtbnfr) and verified.
-- Tighten the atomic paper-rotation RPC (same signature, paper-only, no flag/score/threshold change).
--
-- 1. rotation_allow_score_only_paper: the app refuses score-only execution when this owner key
--    is false; the RPC did not. Both boundaries now agree, so a direct service-role call cannot
--    bypass the owner key.
-- 2. rotation_ledger_binding_v1: p_gate_json is caller-supplied, so `p1_readiness.ready = true`
--    inside it proved nothing about what the evaluator actually concluded. The RPC now also
--    requires an append-only `rotation_events` row (written by the shadow evaluator seconds
--    earlier) for the same market, candidate signal and source position with status 'planned',
--    audit p1_ready = true, matching buy notional, created within the last 120 seconds.
--
-- Effect today: no behaviour change for any real path (the shadow row precedes every call);
-- forged or stale claims are refused. Idempotent: a marker in the function body short-circuits.
begin;
do $migration$
declare
  signature regprocedure := to_regprocedure('public.execute_paper_rotation(text,text,uuid,text,uuid,numeric,numeric,numeric,numeric,text,numeric,numeric,numeric,text,uuid,jsonb)');
  definition text;
  key_anchor text := '  if exists (select 1 from public.rotation_events where idempotency_key = p_idempotency_key) then';
  ledger_anchor text := '  if v_src.exit_reason is not null or v_src.current_price is null';
begin
  if signature is null then raise exception 'execute_paper_rotation signature missing'; end if;
  definition := pg_get_functiondef(signature);
  if position('rotation_ledger_binding_v1' in definition) > 0 then return; end if;
  if position('rotation_plan_contract_v1' in definition) = 0 then
    raise exception 'rotation_plan_contract_v1 missing; apply 20260925163623 first';
  end if;
  if array_length(string_to_array(definition, key_anchor), 1) <> 2
    or array_length(string_to_array(definition, ledger_anchor), 1) <> 2 then
    raise exception 'rotation function changed; review exact source before patching';
  end if;
  definition := replace(definition, key_anchor, $key$
  if not exists (
    select 1 from public.rotation_config
    where market = p_market and book_type = 'paper' and rotation_allow_score_only_paper is true
  ) then
    return jsonb_build_object('ok', false, 'error', 'score_only_execution_disabled');
  end if;

$key$ || key_anchor);
  definition := replace(definition, ledger_anchor, $ledger$
  -- rotation_ledger_binding_v1: the caller's JSON must be backed by the evaluator's append-only row.
  if not exists (
    select 1 from public.rotation_events e
    where e.market = p_market and e.book_type = 'paper' and e.status = 'planned'
      and e.candidate_signal_id = p_candidate_signal_id
      and e.source_position_id = v_src.id
      and (e.audit_json->>'p1_ready')::boolean is true
      and e.created_at >= clock_timestamp() - interval '120 seconds'
      and e.buy_notional is not null
      and abs(e.buy_notional - p_candidate_qty * p_candidate_fill_price) <= 0.000001
  ) then
    return jsonb_build_object('ok', false, 'error', 'rotation_ledger_unbound');
  end if;
$ledger$ || ledger_anchor);
  execute definition;
end;
$migration$;
commit;
