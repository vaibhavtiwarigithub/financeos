-- Property P0: separate, owner-only registry and append-only source-run ledger.
-- These tables intentionally contain no address, financial account, listing, or
-- market observation data. They cannot participate in investment workflows.

create table if not exists public.property_geographies (
  id uuid primary key default gen_random_uuid(),
  slug text not null unique,
  display_name text not null,
  country_code text not null check (country_code in ('US', 'IN')),
  region_name text not null,
  geography_kind text not null check (geography_kind in ('metro', 'city')),
  currency_code text not null check (currency_code in ('USD', 'INR')),
  local_unit_label text not null,
  active boolean not null default true,
  created_at timestamptz not null default now()
);

create table if not exists public.property_sources (
  id uuid primary key default gen_random_uuid(),
  source_key text not null unique,
  display_name text not null,
  official_url text not null,
  permitted_use text not null,
  cadence text not null,
  activation_state text not null default 'contract_pending'
    check (activation_state in ('contract_pending', 'active', 'retired')),
  created_at timestamptz not null default now(),
  check (official_url ~* '^https://')
);

create table if not exists public.property_source_runs (
  id bigint generated always as identity primary key,
  source_key text not null references public.property_sources(source_key),
  geography_slug text references public.property_geographies(slug),
  started_at timestamptz not null default now(),
  completed_at timestamptz,
  outcome text not null check (outcome in ('success', 'partial', 'failed', 'skipped')),
  rows_written integer not null default 0 check (rows_written >= 0),
  request_count integer not null default 0 check (request_count >= 0),
  error_code text,
  detail text,
  created_at timestamptz not null default now()
);

alter table public.property_geographies enable row level security;
alter table public.property_sources enable row level security;
alter table public.property_source_runs enable row level security;
revoke all on public.property_geographies, public.property_sources, public.property_source_runs from anon, authenticated;

-- Service-role-only writes; APIs must remain owner-gated. This avoids exposing
-- future private/property source data through the generic client.
create or replace function public.prevent_property_source_run_mutation()
returns trigger language plpgsql set search_path = public as $$
begin
  raise exception 'property_source_runs is append-only';
end;
$$;
create trigger property_source_runs_append_only
before update or delete on public.property_source_runs
for each row execute function public.prevent_property_source_run_mutation();

insert into public.property_geographies (slug, display_name, country_code, region_name, geography_kind, currency_code, local_unit_label)
values
  ('austin', 'Austin', 'US', 'Central Texas', 'metro', 'USD', 'Metro, county, ZIP'),
  ('phoenix', 'Phoenix', 'US', 'Arizona Metro', 'metro', 'USD', 'Metro, county, ZIP'),
  ('bengaluru', 'Bengaluru', 'IN', 'Karnataka', 'city', 'INR', 'City, locality, PIN, ward')
on conflict (slug) do update set
  display_name = excluded.display_name, region_name = excluded.region_name,
  local_unit_label = excluded.local_unit_label, active = true;

insert into public.property_sources (source_key, display_name, official_url, permitted_use, cadence)
values
  ('fhfa-hpi', 'FHFA House Price Index', 'https://www.fhfa.gov/data/hpi', 'US repeat-sales price trend context', 'Quarterly'),
  ('redfin-data-center', 'Redfin Data Center', 'https://www.redfin.com/news/data-center/', 'Published aggregate market-condition downloads', 'Weekly metro / monthly small geography'),
  ('fred-mortgage', 'Freddie Mac via FRED', 'https://fred.stlouisfed.org/series/MORTGAGE30US', 'US mortgage-rate context', 'Weekly'),
  ('census-bls-hud', 'Census, BLS, and HUD', 'https://www.huduser.gov/portal/datasets/fmr.html', 'US income, employment, and rent-reference context', 'Monthly to annual'),
  ('nhb-residex', 'NHB RESIDEX', 'https://residex.nhbonline.org.in/Dashboard/About', 'India published price, land, and rent index context', 'Quarterly'),
  ('rbi-hpi', 'Reserve Bank of India HPI', 'https://www.rbi.org.in/', 'India city HPI and policy-rate context', 'Quarterly')
on conflict (source_key) do update set
  display_name = excluded.display_name, official_url = excluded.official_url,
  permitted_use = excluded.permitted_use, cadence = excluded.cadence;
