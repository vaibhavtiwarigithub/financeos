-- Property P2-P4: encrypted private records and immutable decision evidence.
-- Private plaintext never enters Postgres; owner-gated server routes encrypt it.

create table if not exists public.property_assets (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  geography_slug text not null references public.property_geographies(slug),
  asset_type text not null check (asset_type in ('home','rental','land')),
  display_label text not null check (char_length(display_label) between 1 and 80),
  encrypted_payload text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.property_financing_accounts (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  property_asset_id uuid references public.property_assets(id) on delete cascade,
  financing_type text not null check (financing_type in ('mortgage','refinance_quote','heloc','home_loan','loan_against_property')),
  display_label text not null check (char_length(display_label) between 1 and 80),
  encrypted_payload text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.property_scenarios (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  geography_slug text not null references public.property_geographies(slug),
  property_asset_id uuid references public.property_assets(id) on delete set null,
  scenario_type text not null check (scenario_type in ('buy','sell','rent','refinance','heloc','home_loan','loan_against_property','downside')),
  encrypted_inputs text not null,
  result_json jsonb not null,
  engine_version text not null,
  decision_state text not null check (decision_state in ('actionable','watch','not_economic_under_assumptions','insufficient_inputs')),
  created_at timestamptz not null default now()
);

create table if not exists public.property_imports (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  geography_slug text references public.property_geographies(slug),
  import_type text not null check (import_type in ('comps','lender_quote','rent_roll','tax_notice','insurance_quote','registration_evidence')),
  source_label text not null check (char_length(source_label) between 1 and 120),
  content_hash text not null,
  encrypted_content text not null,
  as_of date,
  created_at timestamptz not null default now(),
  unique(owner_id, content_hash)
);

create table if not exists public.property_forecast_outcomes (
  id bigint generated always as identity primary key,
  forecast_id bigint not null unique references public.property_forecasts(id) on delete restrict,
  actual_value numeric not null,
  evaluated_at timestamptz not null default now(),
  absolute_error numeric not null check (absolute_error >= 0),
  interval_covered boolean not null
);

create table if not exists public.property_decision_journal (
  id bigint generated always as identity primary key,
  owner_id uuid not null references auth.users(id) on delete cascade,
  scenario_id uuid references public.property_scenarios(id) on delete set null,
  geography_slug text not null references public.property_geographies(slug),
  recommendation_state text not null check (recommendation_state in ('actionable','watch','not_economic_under_assumptions','insufficient_inputs')),
  evidence_refs jsonb not null default '[]'::jsonb,
  owner_action text,
  created_at timestamptz not null default now()
);

create index if not exists property_assets_owner_idx on public.property_assets(owner_id, updated_at desc);
create index if not exists property_scenarios_owner_idx on public.property_scenarios(owner_id, created_at desc);
create index if not exists property_imports_owner_idx on public.property_imports(owner_id, created_at desc);
create index if not exists property_decision_journal_owner_idx on public.property_decision_journal(owner_id, created_at desc);

alter table public.property_assets enable row level security;
alter table public.property_financing_accounts enable row level security;
alter table public.property_scenarios enable row level security;
alter table public.property_imports enable row level security;
alter table public.property_forecast_outcomes enable row level security;
alter table public.property_decision_journal enable row level security;
revoke all on public.property_assets, public.property_financing_accounts, public.property_scenarios,
  public.property_imports, public.property_forecast_outcomes, public.property_decision_journal from anon, authenticated;

-- Revision integrity: source_version is NULLABLE and sits inside the observation
-- uniqueness key. Postgres treats NULLs as DISTINCT by default, so two rows with
-- the same (source_key, geography, metric, as_of, revision_state) and a NULL
-- source_version BOTH insert — silent logical duplication, exactly the risk the
-- handoff flags first. NULLS NOT DISTINCT closes it without forcing a sentinel
-- value that would misrepresent "the source published no version". Safe to do
-- now: the table holds zero rows.
alter table public.property_market_observations
  drop constraint if exists property_market_observations_source_key_geography_slug_metr_key;
create unique index if not exists property_market_observations_identity_key
  on public.property_market_observations
  (source_key, geography_slug, metric_key, as_of, revision_state, source_version)
  nulls not distinct;

create or replace function public.prevent_property_evidence_mutation()
returns trigger language plpgsql set search_path = public as $$
begin raise exception '% is append-only', tg_table_name; end;
$$;

-- Statement-level TRUNCATE guard. A BEFORE ROW trigger does NOT fire on
-- TRUNCATE, so the row triggers below leave every "append-only" table fully
-- erasable. This is the identical hole found and closed on 2026-08-01 in
-- 20260801160000_exogenous_risk_truncate_guard.sql; repeating it here would
-- reintroduce a defect this repo has already paid for once.
create or replace function public.prevent_property_evidence_truncate()
returns trigger language plpgsql set search_path = public as $$
begin raise exception '% is append-only and cannot be truncated', tg_table_name; end;
$$;

-- CREATE TRIGGER has no IF NOT EXISTS in any Postgres version, so the original
-- statements made this migration fail on any re-run. Drop-then-create keeps it
-- idempotent, which the deployment contract requires.
do $$
declare t text;
begin
  foreach t in array array[
    'property_scenarios','property_forecasts','property_forecast_outcomes',
    'property_market_observations','property_decision_journal'
  ] loop
    execute format('drop trigger if exists %I_append_only on public.%I', t, t);
    execute format(
      'create trigger %I_append_only before update or delete on public.%I '
      'for each row execute function public.prevent_property_evidence_mutation()', t, t);
    execute format('drop trigger if exists %I_no_truncate on public.%I', t, t);
    execute format(
      'create trigger %I_no_truncate before truncate on public.%I '
      'for each statement execute function public.prevent_property_evidence_truncate()', t, t);
    -- Grants are the second, independent barrier. The writers only INSERT.
    execute format('revoke update, delete, truncate on public.%I from service_role', t);
  end loop;
end $$;

-- A source that structurally cannot cover a market is not a "success" with zero
-- rows, and not a "skipped" (which means the source is deactivated). Without
-- this outcome, Bengaluru's real coverage gap was indistinguishable from a quiet
-- collection day.
alter table public.property_source_runs
  drop constraint if exists property_source_runs_outcome_check;
alter table public.property_source_runs
  add constraint property_source_runs_outcome_check
  check (outcome = any (array['success','partial','failed','skipped','not_applicable']));

-- Official structured sources verified for automated aggregate collection.
update public.property_sources set activation_state = 'active'
where source_key in ('fhfa-hpi', 'fred-mortgage');

insert into public.property_sources (source_key, display_name, official_url, permitted_use, cadence, activation_state)
values
 ('bls-laus','BLS Local Area Unemployment','https://www.bls.gov/lau/','Metro unemployment-rate context with BLS attribution','Monthly','active'),
 ('census-acs','Census ACS 5-year','https://www.census.gov/data/developers/data-sets/acs-5year.html','Metro income, rent, and value estimates with Census attribution','Annual','contract_pending'),
 ('hud-fmr','HUD FMR / SAFMR','https://www.huduser.gov/portal/dataset/fmr-api.html','Rental affordability reference, not a market-rent comparable','Annual','contract_pending')
on conflict (source_key) do update set display_name=excluded.display_name, official_url=excluded.official_url,
 permitted_use=excluded.permitted_use, cadence=excluded.cadence, activation_state=excluded.activation_state;

do $$ declare jid bigint; begin
  for jid in select jobid from cron.job where jobname in ('kairos-property-collect','kairos-property-forecast') loop
    perform cron.unschedule(jid);
  end loop;
end $$;
select cron.schedule('kairos-property-collect','0 10 * * 0',
  $$select public.kairos_call_agent('/api/property/collect', '{}'::jsonb, 'POST', 55000)$$);
select cron.schedule('kairos-property-forecast','30 10 * * 0',
  $$select public.kairos_call_agent('/api/property/forecasts', '{}'::jsonb, 'POST', 55000)$$);
