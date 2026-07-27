-- International equity allocation P1: source-backed, observation-only policy.
-- This is not a trading feature. The sole initial policy is VXUS in the US/USD
-- book with no target, no band, and no execution permission.

create table if not exists public.international_allocation_policies (
  id uuid primary key default gen_random_uuid(),
  market text not null check (market = 'us'),
  policy_key text not null unique,
  construction text not null check (construction in ('broad_core', 'developed_emerging_split')),
  core_symbol text not null,
  status text not null default 'observe' check (status in ('observe', 'shadow', 'paper', 'live')),
  target_pct numeric,
  deadband_pct numeric,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check ((target_pct is null or (target_pct >= 0 and target_pct <= 100))),
  check ((deadband_pct is null or (deadband_pct >= 0 and deadband_pct <= 100))),
  check (not (status = 'observe' and (target_pct is not null or deadband_pct is not null)))
);

create table if not exists public.fund_exposure_snapshots (
  id uuid primary key default gen_random_uuid(),
  policy_id uuid not null references public.international_allocation_policies(id) on delete restrict,
  fund_symbol text not null,
  market text not null check (market = 'us'),
  currency text not null check (currency = 'USD'),
  archetype text not null check (archetype in ('international_equity_core', 'international_equity_developed', 'international_equity_emerging', 'country_equity_satellite')),
  source_name text not null,
  source_url text not null,
  source_as_of date,
  retrieved_at timestamptz not null default now(),
  coverage_pct numeric not null check (coverage_pct >= 0 and coverage_pct <= 100),
  quality text not null check (quality in ('complete', 'partial', 'stale', 'unavailable')),
  exposure jsonb not null,
  payload_fingerprint text not null,
  created_at timestamptz not null default now(),
  check (jsonb_typeof(exposure) = 'object')
);

create table if not exists public.international_allocation_assessments (
  id uuid primary key default gen_random_uuid(),
  policy_id uuid not null references public.international_allocation_policies(id) on delete restrict,
  snapshot_id uuid not null references public.fund_exposure_snapshots(id) on delete restrict,
  assessed_at timestamptz not null default now(),
  us_paper_invested_value numeric not null check (us_paper_invested_value >= 0),
  recognized_international_value numeric not null check (recognized_international_value >= 0),
  recognized_international_pct numeric,
  assessment_status text not null check (assessment_status in ('disabled_no_target', 'hold', 'below_band', 'above_band', 'unavailable')),
  reason text not null,
  position_fingerprint text not null,
  inputs jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  check (recognized_international_value <= us_paper_invested_value),
  check (recognized_international_pct is null or (recognized_international_pct >= 0 and recognized_international_pct <= 100)),
  check (jsonb_typeof(inputs) = 'object')
);

create index if not exists fund_exposure_snapshots_policy_retrieved_idx
  on public.fund_exposure_snapshots (policy_id, retrieved_at desc);
create index if not exists international_allocation_assessments_policy_assessed_idx
  on public.international_allocation_assessments (policy_id, assessed_at desc);

-- These source and assessment records are a service-only audit layer. The app
-- reads them through the server BFF; no browser role has a table grant.
alter table public.international_allocation_policies enable row level security;
alter table public.fund_exposure_snapshots enable row level security;
alter table public.international_allocation_assessments enable row level security;
revoke all on table public.international_allocation_policies from public, anon, authenticated;
revoke all on table public.fund_exposure_snapshots from public, anon, authenticated;
revoke all on table public.international_allocation_assessments from public, anon, authenticated;

create or replace function public.reject_international_allocation_history_mutation()
returns trigger
language plpgsql
set search_path = pg_catalog, public
as $$
begin
  raise exception 'international allocation history is append-only';
end;
$$;

drop trigger if exists fund_exposure_snapshots_append_only on public.fund_exposure_snapshots;
create trigger fund_exposure_snapshots_append_only
before update or delete on public.fund_exposure_snapshots
for each row execute function public.reject_international_allocation_history_mutation();

drop trigger if exists international_allocation_assessments_append_only on public.international_allocation_assessments;
create trigger international_allocation_assessments_append_only
before update or delete on public.international_allocation_assessments
for each row execute function public.reject_international_allocation_history_mutation();

insert into public.international_allocation_policies (
  market, policy_key, construction, core_symbol, status, target_pct, deadband_pct
) values (
  'us', 'us_non_us_broad_core_v1', 'broad_core', 'VXUS', 'observe', null, null
) on conflict (policy_key) do nothing;

-- Observed classification only. The registry's database constraint preserves
-- new_entry_allowed=false, so this cannot authorize ResearchAgent/PaperTrader.
insert into public.instrument_registry (
  market, symbol, instrument_kind, classification_source, classification_confidence,
  review_status, new_entry_allowed, last_observed_at
) values (
  'us', 'VXUS', 'etf', 'curated_static', 'curated', 'reviewed', false, now()
) on conflict (market, symbol) do update set
  instrument_kind = excluded.instrument_kind,
  classification_source = excluded.classification_source,
  classification_confidence = excluded.classification_confidence,
  review_status = excluded.review_status,
  new_entry_allowed = false,
  last_observed_at = excluded.last_observed_at;

-- Official issuer source, captured as a narrow mandate snapshot. It proves
-- broad developed/emerging ex-US scope, but intentionally does NOT fabricate a
-- country-weight breakdown; quality stays partial until a point-in-time
-- holdings source is added in a later approved increment.
insert into public.fund_exposure_snapshots (
  policy_id, fund_symbol, market, currency, archetype, source_name, source_url,
  source_as_of, coverage_pct, quality, exposure, payload_fingerprint
)
select
  p.id, 'VXUS', 'us', 'USD', 'international_equity_core', 'Vanguard',
  'https://investor.vanguard.com/investment-products/etfs/profile/vxus',
  current_date, 100, 'partial',
  jsonb_build_object(
    'geography_scope', 'broad_ex_us',
    'developed_markets', true,
    'emerging_markets', true,
    'country_breakdown_available', false,
    'index', 'FTSE Global All Cap ex US Index',
    'statement', 'Broad exposure across developed and emerging non-U.S. equity markets'
  ),
  '10a2029cdd9077847f018c381824511de2cb1202aadfc0a671f921c0cad17018'
from public.international_allocation_policies p
where p.policy_key = 'us_non_us_broad_core_v1'
  and not exists (
    select 1 from public.fund_exposure_snapshots s
    where s.policy_id = p.id
      and s.payload_fingerprint = '10a2029cdd9077847f018c381824511de2cb1202aadfc0a671f921c0cad17018'
  );

create or replace function public.refresh_international_allocation_assessment()
returns uuid
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_policy_id uuid;
  v_snapshot_id uuid;
  v_invested numeric := 0;
  v_recognized numeric := 0;
  v_fingerprint text;
  v_assessment_id uuid;
begin
  select id into v_policy_id
  from public.international_allocation_policies
  where policy_key = 'us_non_us_broad_core_v1' and status = 'observe'
  limit 1;
  if v_policy_id is null then return null; end if;

  select id into v_snapshot_id
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
    recognized_international_pct, assessment_status, reason, position_fingerprint, inputs
  ) values (
    v_policy_id, v_snapshot_id, v_invested, v_recognized,
    case when v_invested > 0 then (v_recognized / v_invested) * 100 else null end,
    'disabled_no_target',
    'Observation only: VXUS has no target or band, so no allocation action can be proposed.',
    coalesce(v_fingerprint, md5('[]')),
    jsonb_build_object('market', 'us', 'currency', 'USD', 'source', 'persisted_paper_positions')
  ) returning id into v_assessment_id;

  return v_assessment_id;
end;
$$;

revoke all on function public.refresh_international_allocation_assessment() from public, anon, authenticated;

select public.refresh_international_allocation_assessment();
