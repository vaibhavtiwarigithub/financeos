-- Evidence-gated autonomous selection for LLM/learner-generated challengers.
-- This only changes the PAPER champion. Live approvals, accounts, orders and
-- execution settings are outside this lifecycle.

alter table public.strategy_validation_automation
  add column if not exists auto_promote_enabled boolean not null default true;

create table if not exists public.strategy_promotion_evaluations (
  id bigserial primary key,
  strategy_version_id bigint not null references public.strategy_versions(id),
  market text not null check (market in ('us','india')),
  horizon_sessions integer not null check (horizon_sessions in (2,5,10,20)),
  status text not null check (status in ('insufficient_evidence','passed','failed')),
  reason text not null,
  observations integer not null check (observations >= 0),
  qualifying_sessions integer not null check (qualifying_sessions >= 0),
  effective_windows integer not null check (effective_windows between 0 and 20),
  candidate_mean_net_return numeric,
  baseline_mean_net_return numeric,
  paired_difference_mean numeric,
  paired_difference_t numeric,
  paired_difference_ci_lower_95 numeric,
  evaluation_start date,
  evaluation_end date,
  method text not null check (method = 'matched_shadow_decisions_nonoverlap_horizon_blocks_v1'),
  evaluated_at timestamptz not null default now(),
  check (evaluation_end is null or evaluation_start is null or evaluation_end >= evaluation_start),
  check (status = 'insufficient_evidence' or (
    effective_windows = 20 and candidate_mean_net_return is not null and baseline_mean_net_return is not null
    and paired_difference_mean is not null and paired_difference_t is not null
    and paired_difference_ci_lower_95 is not null
  ))
);
alter table public.strategy_promotion_evaluations enable row level security;
revoke all on public.strategy_promotion_evaluations from public, anon, authenticated;
grant select, insert on public.strategy_promotion_evaluations to service_role;
revoke update, delete, truncate on public.strategy_promotion_evaluations from service_role;
revoke all on sequence public.strategy_promotion_evaluations_id_seq from public, anon, authenticated;
grant usage, select on sequence public.strategy_promotion_evaluations_id_seq to service_role;

create or replace function public.prevent_strategy_promotion_evaluation_mutation()
returns trigger language plpgsql set search_path = pg_catalog, public as $$
begin
  raise exception 'strategy_promotion_evaluations are immutable';
end $$;
drop trigger if exists strategy_promotion_evaluations_immutable_trg on public.strategy_promotion_evaluations;
create trigger strategy_promotion_evaluations_immutable_trg
  before update or delete on public.strategy_promotion_evaluations
  for each row execute function public.prevent_strategy_promotion_evaluation_mutation();

create table if not exists public.strategy_promotion_events (
  id bigserial primary key,
  evaluation_id bigint not null references public.strategy_promotion_evaluations(id),
  strategy_version_id bigint not null references public.strategy_versions(id),
  prior_champion_id bigint references public.strategy_versions(id),
  event text not null check (event in ('paper_champion_selected','shadow_retired')),
  occurred_at timestamptz not null default now(),
  unique (evaluation_id)
);
create index if not exists strategy_promotion_evaluations_latest_idx
  on public.strategy_promotion_evaluations(strategy_version_id, evaluated_at desc);
create unique index if not exists strategy_promotion_evaluations_terminal_uidx
  on public.strategy_promotion_evaluations(strategy_version_id) where status in ('passed','failed');
alter table public.strategy_promotion_events enable row level security;
revoke all on public.strategy_promotion_events from public, anon, authenticated;
grant select on public.strategy_promotion_events to service_role;
revoke insert, update, delete, truncate on public.strategy_promotion_events from service_role;
revoke all on sequence public.strategy_promotion_events_id_seq from public, anon, authenticated, service_role;
grant usage, select on sequence public.strategy_promotion_events_id_seq to service_role;

create or replace function public.prevent_strategy_promotion_event_mutation()
returns trigger language plpgsql set search_path = pg_catalog, public as $$
begin
  raise exception 'strategy_promotion_events are append-only';
end $$;
drop trigger if exists strategy_promotion_events_append_only_trg on public.strategy_promotion_events;
create trigger strategy_promotion_events_append_only_trg
  before update or delete on public.strategy_promotion_events
  for each row execute function public.prevent_strategy_promotion_event_mutation();

-- Close the old validation-only promotion path. Both automated and owner
-- initiated promotion now require the same completed forward-shadow evidence.
create or replace function public.promote_strategy_champion(p_version_id bigint)
returns jsonb language plpgsql security definer set search_path = pg_catalog, public as $$
declare
  v_market text;
  v_validation_id bigint;
  v_state text;
  v_passed boolean;
  v_evidence public.strategy_promotion_evaluations;
begin
  select market, validation_experiment_id, state into v_market, v_validation_id, v_state
  from public.strategy_versions where id = p_version_id for update;
  if not found then raise exception using errcode = 'P0002', message = 'strategy version not found'; end if;
  if v_market not in ('us','india') then raise exception 'invalid strategy market'; end if;
  if v_state <> 'shadow_paper' then raise exception 'strategy must complete its forward shadow first'; end if;
  if v_validation_id is null then raise exception 'passed historical validation is required'; end if;
  select passed into v_passed from public.validation_experiments
    where id = v_validation_id and challenger_id = p_version_id;
  if coalesce(v_passed,false) is not true then raise exception 'passed historical validation is required'; end if;
  select * into v_evidence from public.strategy_promotion_evaluations
    where strategy_version_id = p_version_id and status = 'passed'
    order by evaluated_at desc limit 1;
  if not found or v_evidence.effective_windows < 20
     or coalesce(v_evidence.candidate_mean_net_return,0) <= 0
     or coalesce(v_evidence.paired_difference_ci_lower_95,0) <= 0
     or coalesce(v_evidence.paired_difference_t,0) < 2.093 then
    raise exception 'completed positive forward-shadow evidence is required';
  end if;
  perform pg_advisory_xact_lock(hashtext('strategy-promotion:' || v_market));
  update public.strategy_versions set is_champion = false
    where market = v_market and is_champion = true and id <> p_version_id;
  update public.strategy_versions set is_champion = true, state = 'paper_active', promoted_at = now()
    where id = p_version_id and market = v_market;
  if not found then raise exception 'promotion update failed'; end if;
  return jsonb_build_object('promoted',p_version_id,'market',v_market);
end $$;
revoke all on function public.promote_strategy_champion(bigint) from public, anon, authenticated;
grant execute on function public.promote_strategy_champion(bigint) to service_role;

create or replace function public.apply_strategy_shadow_evaluation(p_evaluation_id bigint)
returns jsonb language plpgsql security definer set search_path = pg_catalog, public as $$
declare
  v_eval public.strategy_promotion_evaluations;
  v_market text;
  v_enabled boolean;
  v_state text;
  v_champion bigint;
  v_result jsonb;
begin
  select * into v_eval from public.strategy_promotion_evaluations
    where id = p_evaluation_id for update;
  if not found then raise exception 'promotion evaluation not found'; end if;
  perform pg_advisory_xact_lock(hashtext('strategy-promotion:' || v_eval.market));
  select auto_promote_enabled into v_enabled from public.strategy_validation_automation
    where market = v_eval.market for update;
  if not found or v_enabled is not true then
    return jsonb_build_object('applied',false,'reason','auto_promotion_disabled');
  end if;
  select state into v_state from public.strategy_versions
    where id = v_eval.strategy_version_id and market = v_eval.market for update;
  if not found or v_state <> 'shadow_paper' then
    return jsonb_build_object('applied',false,'reason','candidate_not_in_shadow');
  end if;
  if exists (select 1 from public.strategy_promotion_events where evaluation_id = v_eval.id) then
    return jsonb_build_object('applied',true,'reason','already_applied');
  end if;
  if v_eval.status = 'insufficient_evidence' then
    return jsonb_build_object('applied',false,'reason','forward_evidence_insufficient');
  elsif v_eval.status = 'passed' then
    if v_eval.effective_windows < 20
       or coalesce(v_eval.paired_difference_ci_lower_95,0) <= 0
       or coalesce(v_eval.paired_difference_t,0) < 2.093
       or coalesce(v_eval.candidate_mean_net_return,0) <= 0 then
      raise exception 'passed evaluation is missing its forward evidence gate';
    end if;
    select id into v_champion from public.strategy_versions
      where market = v_eval.market and is_champion = true order by promoted_at desc nulls last limit 1;
    v_result := public.promote_strategy_champion(v_eval.strategy_version_id);
    insert into public.strategy_promotion_events(evaluation_id,strategy_version_id,prior_champion_id,event)
    values(v_eval.id,v_eval.strategy_version_id,v_champion,'paper_champion_selected');
    return jsonb_build_object('applied',true,'event','paper_champion_selected','promotion',v_result);
  end if;

  update public.strategy_versions
    set state='retired', retired_at=now(),
        rejection_reason='autonomous_forward_evidence_gate_failed'
    where id=v_eval.strategy_version_id and market=v_eval.market;
  insert into public.strategy_promotion_events(evaluation_id,strategy_version_id,prior_champion_id,event)
  values(v_eval.id,v_eval.strategy_version_id,null,'shadow_retired');
  return jsonb_build_object('applied',true,'event','shadow_retired','reason',v_eval.reason);
end $$;
revoke all on function public.apply_strategy_shadow_evaluation(bigint) from public, anon, authenticated;
grant execute on function public.apply_strategy_shadow_evaluation(bigint) to service_role;
