-- Reversible, per-market automation for deterministic challenger validation.
-- This policy can only move a passed challenger into non-executing shadow_paper;
-- it cannot promote a champion or touch paper/live execution paths.

create table if not exists public.strategy_validation_automation (
  market text primary key check (market in ('us', 'india')),
  enabled boolean not null default true,
  auto_shadow_enabled boolean not null default true,
  max_active_shadows int not null default 1 check (max_active_shadows between 0 and 1),
  updated_by uuid references auth.users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.strategy_validation_automation enable row level security;
revoke all on public.strategy_validation_automation from public, anon;
revoke all on public.strategy_validation_automation from authenticated;
grant select on public.strategy_validation_automation to authenticated;
drop policy if exists strategy_validation_automation_owner_read on public.strategy_validation_automation;
create policy strategy_validation_automation_owner_read
  on public.strategy_validation_automation for select to authenticated
  using ((auth.jwt() ->> 'email') = 'vterminater@gmail.com');

insert into public.strategy_validation_automation (market, enabled, auto_shadow_enabled, max_active_shadows)
values ('us', true, true, 1), ('india', true, true, 1)
on conflict (market) do nothing;

create or replace function public.activate_strategy_shadow(p_version_id bigint)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_market text;
  v_state text;
  v_is_champion boolean;
  v_validation_id bigint;
  v_passed boolean;
  v_enabled boolean;
  v_auto_shadow boolean;
  v_max_shadows int;
  v_active_count int;
begin
  select market, state, is_champion, validation_experiment_id
  into v_market, v_state, v_is_champion, v_validation_id
  from public.strategy_versions where id = p_version_id for update;
  if not found then return jsonb_build_object('activated', false, 'reason', 'strategy_not_found'); end if;
  perform pg_advisory_xact_lock(hashtext('strategy-shadow:' || v_market));
  select enabled, auto_shadow_enabled, max_active_shadows
  into v_enabled, v_auto_shadow, v_max_shadows
  from public.strategy_validation_automation where market = v_market for update;
  if not found or not v_enabled or not v_auto_shadow then
    return jsonb_build_object('activated', false, 'reason', 'automation_disabled');
  end if;
  if v_is_champion or v_state in ('retired', 'rejected', 'live_approved', 'approved_live') then
    return jsonb_build_object('activated', false, 'reason', 'invalid_strategy_state');
  end if;
  if v_state = 'shadow_paper' then return jsonb_build_object('activated', true, 'reason', 'already_shadow'); end if;
  select passed into v_passed from public.validation_experiments
  where id = v_validation_id and challenger_id = p_version_id;
  if coalesce(v_passed, false) is not true then
    return jsonb_build_object('activated', false, 'reason', 'validation_not_passed');
  end if;
  select count(*) into v_active_count from public.strategy_versions
  where market = v_market and state = 'shadow_paper' and id <> p_version_id;
  if v_active_count >= v_max_shadows then
    return jsonb_build_object('activated', false, 'reason', 'shadow_capacity_reached', 'active_count', v_active_count);
  end if;
  update public.strategy_versions set state = 'shadow_paper' where id = p_version_id;
  return jsonb_build_object('activated', true, 'market', v_market);
end; $$;

revoke all on function public.activate_strategy_shadow(bigint) from public, anon, authenticated;
grant execute on function public.activate_strategy_shadow(bigint) to service_role;

-- Cloud scheduler is the production authority. It catches challengers created
-- outside LearnerAgent or interrupted before in-process validation completed.
do $$
begin
  perform cron.unschedule('kairos-validation-sweep');
exception when others then null;
end $$;
select cron.schedule('kairos-validation-sweep', '45 21 * * 5',
  $$select public.kairos_call_agent('/api/validation/sweep', '{}'::jsonb, 'POST', 120000)$$);
