-- International allocation P2A: weekly operational shadow for the one approved
-- VXUS observation policy. This writes audit rows only; it cannot set a target,
-- create a position, call a provider, or submit an order.

alter table public.international_allocation_assessments
  add column if not exists observation_kind text not null default 'p1_manual'
    check (observation_kind in ('p1_manual', 'p2_weekly')),
  add column if not exists shadow_week date,
  add column if not exists proposed_action jsonb not null default '{}'::jsonb
    check (jsonb_typeof(proposed_action) = 'object'),
  add column if not exists cost_assumptions jsonb not null default '{}'::jsonb
    check (jsonb_typeof(cost_assumptions) = 'object'),
  add column if not exists coverage jsonb not null default '{}'::jsonb
    check (jsonb_typeof(coverage) = 'object');

create unique index if not exists international_allocation_weekly_shadow_once_idx
  on public.international_allocation_assessments (policy_id, shadow_week)
  where observation_kind = 'p2_weekly';

drop function if exists public.refresh_international_allocation_assessment();

create or replace function public.refresh_international_allocation_assessment(
  p_observation_kind text default 'p1_manual'
)
returns uuid
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_policy_id uuid;
  v_snapshot_id uuid;
  v_snapshot_quality text;
  v_country_breakdown boolean;
  v_invested numeric := 0;
  v_recognized numeric := 0;
  v_fingerprint text;
  v_assessment_id uuid;
  v_shadow_week date := date_trunc('week', current_date)::date;
begin
  if p_observation_kind not in ('p1_manual', 'p2_weekly') then
    raise exception 'invalid international allocation observation kind';
  end if;

  select id into v_policy_id
  from public.international_allocation_policies
  where policy_key = 'us_non_us_broad_core_v1' and status = 'observe'
  limit 1;
  if v_policy_id is null then return null; end if;

  if p_observation_kind = 'p2_weekly' and exists (
    select 1 from public.international_allocation_assessments
    where policy_id = v_policy_id and observation_kind = 'p2_weekly' and shadow_week = v_shadow_week
  ) then
    return null;
  end if;

  select id, quality, coalesce((exposure ->> 'country_breakdown_available')::boolean, false)
  into v_snapshot_id, v_snapshot_quality, v_country_breakdown
  from public.fund_exposure_snapshots
  where policy_id = v_policy_id
  order by retrieved_at desc, created_at desc
  limit 1;
  if v_snapshot_id is null then return null; end if;

  select coalesce(sum(qty * coalesce(nullif(current_price, 0), avg_cost)), 0)
  into v_invested
  from public.paper_positions
  where coalesce(market, 'us') = 'us';

  select coalesce(sum(qty * coalesce(nullif(current_price, 0), avg_cost)), 0)
  into v_recognized
  from public.paper_positions
  where coalesce(market, 'us') = 'us'
    and symbol in ('VXUS', 'INDA', 'EPI', 'INDY', 'EUAD', 'FEZ', 'VGK', 'EWG', 'EWL', 'EWU', 'EWQ', 'DXJ', 'EWJ', 'EWT', 'EWY', 'EWH', 'FXI', 'ASHR', 'EMXC');

  select md5(coalesce(jsonb_agg(jsonb_build_object(
    'symbol', symbol, 'qty', qty, 'current_price', current_price, 'avg_cost', avg_cost
  ) order by symbol)::text, '[]'))
  into v_fingerprint
  from public.paper_positions
  where coalesce(market, 'us') = 'us';

  insert into public.international_allocation_assessments (
    policy_id, snapshot_id, us_paper_invested_value, recognized_international_value,
    recognized_international_pct, assessment_status, reason, position_fingerprint,
    inputs, observation_kind, shadow_week, proposed_action, cost_assumptions, coverage
  ) values (
    v_policy_id, v_snapshot_id, v_invested, v_recognized,
    case when v_invested > 0 then (v_recognized / v_invested) * 100 else null end,
    'disabled_no_target',
    'P2 shadow suppressed: no owner target or band exists, so no allocation action can be proposed.',
    coalesce(v_fingerprint, md5('[]')),
    jsonb_build_object('market', 'us', 'currency', 'USD', 'source', 'persisted_paper_positions'),
    p_observation_kind,
    case when p_observation_kind = 'p2_weekly' then v_shadow_week else null end,
    jsonb_build_object('action', 'none', 'suppressed', true, 'reason', 'target_and_band_unset'),
    jsonb_build_object('trading_cost_pct', null, 'tax_drag_pct', null, 'reason', 'no hypothetical order until an owner target exists'),
    jsonb_build_object('snapshot_quality', v_snapshot_quality, 'country_breakdown_available', v_country_breakdown, 'position_valuation', 'persisted_paper_marks_or_cost')
  ) returning id into v_assessment_id;

  return v_assessment_id;
end;
$$;

revoke all on function public.refresh_international_allocation_assessment(text) from public, anon, authenticated;

do $$ begin
  perform cron.unschedule('kairos-international-allocation-shadow');
exception when others then null;
end $$;

select cron.schedule(
  'kairos-international-allocation-shadow', '30 3 * * 1',
  $$select public.kairos_call_agent('/api/allocation/international/assess?mode=p2_weekly', '{}'::jsonb, 'POST', 30000)$$
);

select public.refresh_international_allocation_assessment('p2_weekly');
