-- Property Stage 3: ZIP-level area context (Zillow ZHVI Research CSV).
-- Deliberately a SEPARATE table/grain from property_market_observations
-- (metro/county). ZHVI is a middle-third-of-homes area index, never a
-- per-property value, AVM, or Zestimate substitute. Append-only, same
-- pattern as property_county_observations.

create table if not exists public.property_zip_observations (
  id bigint generated always as identity primary key,
  source_key text not null references public.property_sources(source_key),
  market_slug text not null references public.property_geographies(slug),
  zip text not null check (zip ~ '^[0-9]{5}$'),
  metric_key text not null check (metric_key = 'zhvi_all_homes'),
  native_unit text not null check (native_unit = 'USD'),
  value numeric not null check (value > 0),
  as_of date not null,
  source_version text,
  collected_at timestamptz not null default now(),
  unique nulls not distinct (source_key, market_slug, zip, metric_key, as_of, source_version)
);
create index if not exists property_zip_observations_lookup_idx on public.property_zip_observations (market_slug, zip, as_of desc);

alter table public.property_zip_observations enable row level security;
revoke all on public.property_zip_observations from anon, authenticated;

do $$ begin
  if not exists (select 1 from pg_trigger where tgname = 'property_zip_observations_append_only') then
    create trigger property_zip_observations_append_only before update or delete on public.property_zip_observations
      for each row execute function public.prevent_property_evidence_mutation();
  end if;
  if not exists (select 1 from pg_trigger where tgname = 'property_zip_observations_no_truncate') then
    create trigger property_zip_observations_no_truncate before truncate on public.property_zip_observations
      for each statement execute function public.prevent_property_evidence_truncate();
  end if;
end $$;
revoke update, delete, truncate on public.property_zip_observations from service_role;

insert into public.property_sources (source_key, display_name, official_url, permitted_use, cadence, activation_state)
values (
  'zillow-zhvi-zip',
  'Zillow Research ZHVI (ZIP)',
  'https://www.zillow.com/research/data/',
  'Published ZIP-level Zillow Home Value Index (typical value, middle-third smoothed/seasonally-adjusted); area context only, never a per-property value or AVM',
  'Monthly (polled on the weekly Property collection run)',
  'active'
)
on conflict (source_key) do update set
  display_name = excluded.display_name, official_url = excluded.official_url,
  permitted_use = excluded.permitted_use, cadence = excluded.cadence, activation_state = excluded.activation_state;
