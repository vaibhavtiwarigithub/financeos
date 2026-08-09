-- County scope for metro-level Property evidence. No sale or appraisal feed is
-- activated by this registry; it records the exact coverage boundary.
create table if not exists public.property_market_counties (
  market_slug text not null references public.property_geographies(slug),
  county_fips text not null check (county_fips ~ '^[0-9]{5}$'),
  county_name text not null,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  primary key (market_slug, county_fips)
);

create table if not exists public.property_county_observations (
  id bigint generated always as identity primary key,
  source_key text not null references public.property_sources(source_key),
  market_slug text not null,
  county_fips text not null,
  metric_key text not null check (metric_key in ('median_household_income','median_gross_rent','median_home_value','rental_vacancy_rate')),
  native_unit text not null check (native_unit in ('USD','percent')),
  value numeric not null,
  as_of date not null,
  source_version text not null,
  collected_at timestamptz not null default now(),
  revision_state text not null default 'initial' check (revision_state in ('initial','revised')),
  foreign key (market_slug, county_fips) references public.property_market_counties(market_slug, county_fips),
  unique nulls not distinct (source_key, market_slug, county_fips, metric_key, as_of, source_version, revision_state)
);
create index if not exists property_county_observations_lookup_idx on public.property_county_observations(market_slug, county_fips, metric_key, as_of desc);

insert into public.property_market_counties (market_slug, county_fips, county_name) values
  ('austin','48021','Bastrop County'), ('austin','48055','Caldwell County'), ('austin','48209','Hays County'), ('austin','48453','Travis County'), ('austin','48491','Williamson County'),
  ('phoenix','04013','Maricopa County'), ('phoenix','04021','Pinal County')
on conflict (market_slug, county_fips) do update set county_name = excluded.county_name, active = true;

alter table public.property_market_counties enable row level security;
alter table public.property_county_observations enable row level security;
revoke all on public.property_market_counties, public.property_county_observations from anon, authenticated;

do $$ begin
  if not exists (select 1 from pg_trigger where tgname = 'property_county_observations_append_only') then
    create trigger property_county_observations_append_only before update or delete on public.property_county_observations
      for each row execute function public.prevent_property_evidence_mutation();
  end if;
  if not exists (select 1 from pg_trigger where tgname = 'property_county_observations_no_truncate') then
    create trigger property_county_observations_no_truncate before truncate on public.property_county_observations
      for each statement execute function public.prevent_property_evidence_truncate();
  end if;
end $$;
revoke update, delete, truncate on public.property_county_observations from service_role;
