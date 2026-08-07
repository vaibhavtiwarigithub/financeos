-- Property P1/P4 foundation only. No collector or forecast producer is enabled.
create table if not exists public.property_market_observations (
  id bigint generated always as identity primary key,
  source_key text not null references public.property_sources(source_key),
  geography_slug text not null references public.property_geographies(slug),
  metric_key text not null,
  native_unit text not null,
  value numeric not null,
  as_of date not null,
  published_at timestamptz,
  collected_at timestamptz not null default now(),
  source_version text,
  revision_state text not null default 'initial' check (revision_state in ('initial', 'revised')),
  source_hash text,
  unique (source_key, geography_slug, metric_key, as_of, revision_state, source_version)
);
create index if not exists property_observations_lookup_idx on public.property_market_observations (geography_slug, metric_key, as_of desc);

create table if not exists public.property_forecasts (
  id bigint generated always as identity primary key,
  geography_slug text not null references public.property_geographies(slug),
  metric_key text not null,
  horizon_days integer not null check (horizon_days > 0),
  cutoff_at timestamptz not null,
  lower_value numeric not null,
  base_value numeric not null,
  upper_value numeric not null,
  model_version text not null,
  state text not null default 'shadow' check (state in ('shadow', 'retired')),
  created_at timestamptz not null default now(),
  check (lower_value <= base_value and base_value <= upper_value)
);
alter table public.property_market_observations enable row level security;
alter table public.property_forecasts enable row level security;
revoke all on public.property_market_observations, public.property_forecasts from anon, authenticated;
