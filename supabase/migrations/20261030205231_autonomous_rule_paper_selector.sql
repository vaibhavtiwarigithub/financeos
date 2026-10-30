-- Autonomous, evidence-gated strategy discovery -> forward shadow -> paper-only
-- selection. Does not modify scores, sizing, positions, live, or broker paths.
alter table public.strategy_validation_automation
  add column if not exists auto_rule_paper_select_enabled boolean not null default true;
update public.strategy_validation_automation
  set auto_rule_paper_select_enabled = true
  where market in ('us','india') and auto_rule_paper_select_enabled is distinct from true;

create table if not exists public.strategy_template_paper_evaluations (
  id uuid primary key default gen_random_uuid(),
  market text not null check (market in ('us','india')),
  config_id uuid not null references public.strategy_template_shadow_configs(id),
  selector_version text not null,
  status text not null check (status in ('insufficient','retain','select','retire')),
  evidence jsonb not null,
  created_at timestamptz not null default now()
);
create index if not exists strategy_template_paper_evaluations_market_idx
  on public.strategy_template_paper_evaluations(market,created_at desc);
alter table public.strategy_template_paper_evaluations enable row level security;
revoke all on public.strategy_template_paper_evaluations from public,anon,authenticated,service_role;
grant select on public.strategy_template_paper_evaluations to authenticated,service_role;
grant insert on public.strategy_template_paper_evaluations to service_role;
drop policy if exists strategy_template_paper_evaluations_owner_read on public.strategy_template_paper_evaluations;
drop policy if exists strategy_template_paper_evaluations_service_read on public.strategy_template_paper_evaluations;
drop policy if exists strategy_template_paper_evaluations_service_insert on public.strategy_template_paper_evaluations;
create policy strategy_template_paper_evaluations_owner_read on public.strategy_template_paper_evaluations
  for select to authenticated using ((select auth.jwt()->>'email')='vterminater@gmail.com');
create policy strategy_template_paper_evaluations_service_read on public.strategy_template_paper_evaluations
  for select to service_role using (true);
create policy strategy_template_paper_evaluations_service_insert on public.strategy_template_paper_evaluations
  for insert to service_role with check (true);
create or replace function public.strategy_template_paper_evaluations_append_only()
returns trigger language plpgsql as $$ begin raise exception 'strategy template paper evaluations are append-only'; end $$;
drop trigger if exists strategy_template_paper_evaluations_no_mutation on public.strategy_template_paper_evaluations;
create trigger strategy_template_paper_evaluations_no_mutation
  before update or delete on public.strategy_template_paper_evaluations
  for each row execute function public.strategy_template_paper_evaluations_append_only();
revoke truncate on public.strategy_template_paper_evaluations from public,anon,authenticated,service_role;

create table if not exists public.strategy_template_paper_selection (
  market text primary key check (market in ('us','india')),
  config_id uuid references public.strategy_template_shadow_configs(id),
  evaluation_id uuid references public.strategy_template_paper_evaluations(id),
  updated_at timestamptz not null default now()
);
alter table public.strategy_template_paper_selection enable row level security;
revoke all on public.strategy_template_paper_selection from public,anon,authenticated,service_role;
grant select on public.strategy_template_paper_selection to authenticated,service_role;
drop policy if exists strategy_template_paper_selection_owner_read on public.strategy_template_paper_selection;
drop policy if exists strategy_template_paper_selection_service_read on public.strategy_template_paper_selection;
create policy strategy_template_paper_selection_owner_read on public.strategy_template_paper_selection
  for select to authenticated using ((select auth.jwt()->>'email')='vterminater@gmail.com');
create policy strategy_template_paper_selection_service_read on public.strategy_template_paper_selection
  for select to service_role using (true);
create or replace function public.strategy_template_paper_selection_no_direct_write()
returns trigger language plpgsql as $$ begin
  if current_setting('app.template_paper_selection',true) is distinct from '1' then
    raise exception 'paper selection must use its audited RPC';
  end if;
  if tg_op='DELETE' then return old; else return new; end if;
end $$;
drop trigger if exists strategy_template_paper_selection_no_direct_write on public.strategy_template_paper_selection;
create trigger strategy_template_paper_selection_no_direct_write
  before insert or update or delete on public.strategy_template_paper_selection
  for each row execute function public.strategy_template_paper_selection_no_direct_write();

create or replace function public.apply_autonomous_rule_evaluations(
  p_market text, p_evaluations jsonb, p_selected_config_id uuid default null
) returns jsonb language plpgsql security definer set search_path=pg_catalog,public as $$
declare
  v_eval jsonb;
  v_config public.strategy_template_shadow_configs;
  v_eval_id uuid;
  v_selected uuid;
  v_selected_candidate boolean := false;
  v_enabled boolean;
  v_invalid boolean;
begin
  if p_market not in ('us','india') or jsonb_typeof(p_evaluations) <> 'array'
     or jsonb_array_length(p_evaluations) > 3 then raise exception 'invalid autonomous evaluation batch'; end if;
  perform pg_advisory_xact_lock(hashtext('autonomous-rule-paper:'||p_market));
  select auto_rule_paper_select_enabled into v_enabled from public.strategy_validation_automation where market=p_market for update;
  if not coalesce(v_enabled,false) then raise exception 'autonomous rule paper selection disabled'; end if;
  for v_eval in select value from jsonb_array_elements(p_evaluations) loop
    select * into v_config from public.strategy_template_shadow_configs
      where id=(v_eval->>'config_id')::uuid and market=p_market for update;
    if not found or v_config.state <> 'shadow' then raise exception 'evaluation candidate is not an active market-local shadow'; end if;
    if coalesce(v_eval->>'selector_version','')='' or coalesce(v_eval->>'status','') not in ('insufficient','retain','select','retire') then raise exception 'invalid evaluation record'; end if;
    if (v_eval->>'status'='select') and v_eval->>'selector_version' <> 'paired-horizon-spaced-forward-v2' then
      raise exception 'unsupported autonomous selector version';
    end if;
    v_invalid := (v_eval->>'status'='select') and (
      coalesce((v_eval->>'pairedSessions')::integer,0) < 60
      or coalesce((v_eval->>'nonoverlapWindows')::integer,0) < 20
      or coalesce((v_eval->>'trialCount')::integer,0) < 1
      or coalesce((v_eval->>'meanRuleReturnPct')::numeric,0) <= 0
      or coalesce((v_eval->>'meanPairedExcessPct')::numeric,0) <= 0
      or coalesce((v_eval->>'oneSidedT')::numeric,0) < coalesce((v_eval->>'requiredT')::numeric,999999)
      or coalesce((v_eval->>'positiveWindowFraction')::numeric,0) < 0.6
      or coalesce((v_eval->>'firstHalfExcessPct')::numeric,0) <= 0
      or coalesce((v_eval->>'secondHalfExcessPct')::numeric,0) <= 0
      or coalesce((v_eval->>'maxDrawdownRulePct')::numeric,999999) > coalesce((v_eval->>'maxDrawdownBaselinePct')::numeric,-1)
    );
    if v_invalid then raise exception 'paper selection evidence gate failed'; end if;
    insert into public.strategy_template_paper_evaluations(market,config_id,selector_version,status,evidence)
      values(p_market,v_config.id,v_eval->>'selector_version',v_eval->>'status',v_eval)
      returning id into v_eval_id;
    if v_eval->>'status'='retire' and v_config.state='shadow' then
      insert into public.strategy_template_shadow_events(config_id,event,reason,evidence_snapshot,actor)
        values(v_config.id,'retired','autonomous_selector_forward_gate_failed',v_eval,'autonomous_selector');
      perform set_config('app.template_shadow_lifecycle','1',true);
      update public.strategy_template_shadow_configs set state='retired',retired_at=now() where id=v_config.id;
    end if;
    if v_eval->>'status'='select' and p_selected_config_id=v_config.id then v_selected_candidate:=true; end if;
  end loop;
  if p_selected_config_id is not null and not v_selected_candidate then
    raise exception 'selected config is not a passing candidate in this evaluation batch';
  end if;
  v_selected:=p_selected_config_id;
  if v_selected is not null then
    select id into v_eval_id from public.strategy_template_paper_evaluations
      where market=p_market and config_id=v_selected order by created_at desc,id desc limit 1;
    perform set_config('app.template_paper_selection','1',true);
    insert into public.strategy_template_paper_selection(market,config_id,evaluation_id,updated_at)
      values(p_market,v_selected,v_eval_id,now())
      on conflict(market) do update set config_id=excluded.config_id,evaluation_id=excluded.evaluation_id,updated_at=excluded.updated_at;
    insert into public.strategy_template_shadow_events(config_id,event,reason,evidence_snapshot,actor)
      values(v_selected,'paper_selected','autonomous_paired_forward_gate_passed',
        (select evidence from public.strategy_template_paper_evaluations where id=v_eval_id),'autonomous_selector');
  else
    -- A prior selection remains only while it is still an active shadow and
    -- has not just failed a mature evaluation. Never select on insufficient data.
    if exists (select 1 from jsonb_array_elements(p_evaluations) e
      where e->>'status'='retire' and (e->>'config_id')::uuid=(select config_id from public.strategy_template_paper_selection where market=p_market)) then
      perform set_config('app.template_paper_selection','1',true);
      delete from public.strategy_template_paper_selection where market=p_market;
    end if;
  end if;
  return jsonb_build_object('market',p_market,'selected_config_id',coalesce(v_selected,
    (select config_id from public.strategy_template_paper_selection where market=p_market)),
    'evaluations',jsonb_array_length(p_evaluations));
end $$;
revoke all on function public.apply_autonomous_rule_evaluations(text,jsonb,uuid) from public,anon,authenticated;
grant execute on function public.apply_autonomous_rule_evaluations(text,jsonb,uuid) to service_role;

-- Expand the immutable lifecycle audit vocabulary for autonomous decisions.
alter table public.strategy_template_shadow_events drop constraint if exists strategy_template_shadow_events_event_check;
alter table public.strategy_template_shadow_events add constraint strategy_template_shadow_events_event_check
  check (event in ('created','backtest_completed','validating','shadow','paused','resumed','retired','paper_selected'));
