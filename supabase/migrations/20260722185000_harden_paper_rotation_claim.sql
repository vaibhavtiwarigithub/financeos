-- Capital rotation P1 is not architecture-complete. Keep paper execution
-- database-disabled while preserving shadow measurement. Replace the old
-- money-moving RPC with a non-executing claim-verification stub so no service
-- caller can bypass the application deployment gate.

update public.rotation_config
set rotation_paper_execute_enabled = false, updated_at = now()
where rotation_paper_execute_enabled = true;

alter table public.rotation_config
  drop constraint if exists rotation_paper_execution_p1_not_approved;
alter table public.rotation_config
  add constraint rotation_paper_execution_p1_not_approved
  check (rotation_paper_execute_enabled = false);

create or replace function public.execute_paper_rotation(
  p_market text, p_currency text, p_source_position_id uuid,
  p_candidate_symbol text, p_candidate_signal_id uuid, p_candidate_qty numeric,
  p_candidate_fill_price numeric, p_candidate_price_target numeric, p_candidate_stop_loss numeric,
  p_candidate_sector text, p_candidate_score numeric, p_source_score numeric,
  p_score_edge numeric, p_idempotency_key text, p_claim_run_id uuid, p_gate_json jsonb
) returns jsonb
language sql stable security definer set search_path to 'public'
as $function$
  select case
    when p_market not in ('us', 'india')
      or p_currency is distinct from case when p_market = 'india' then 'INR' else 'USD' end
      or p_claim_run_id is null
      then jsonb_build_object('ok', false, 'error', 'invalid_rotation_claim')
    when not exists (
      select 1 from public.agent_signals
      where id = p_candidate_signal_id
        and market = p_market
        and status = 'claiming'
        and claim_run_id = p_claim_run_id
      )
      then jsonb_build_object('ok', false, 'error', 'signal_claim_not_owned')
    else jsonb_build_object('ok', false, 'error', 'p1_guardrails_incomplete')
  end;
$function$;

revoke all on function public.execute_paper_rotation(
  text,text,uuid,text,uuid,numeric,numeric,numeric,numeric,text,numeric,numeric,numeric,text,uuid,jsonb
) from public, anon, authenticated;
grant execute on function public.execute_paper_rotation(
  text,text,uuid,text,uuid,numeric,numeric,numeric,numeric,text,numeric,numeric,numeric,text,uuid,jsonb
) to service_role;

drop function if exists public.execute_paper_rotation(
  text,text,uuid,text,uuid,numeric,numeric,numeric,numeric,text,numeric,numeric,numeric,text,jsonb
);
