create table if not exists public.property_value_observations (
  id bigint generated always as identity primary key,
  owner_id uuid not null references auth.users(id) on delete cascade,
  property_asset_id uuid not null references public.property_assets(id) on delete restrict,
  geography_slug text not null references public.property_geographies(slug),
  currency text not null check (currency in ('USD', 'INR')),
  observed_on date not null,
  kind text not null check (kind in ('purchase_price','owner_estimate','documented_appraisal','observed_sale','county_appraised_reference','county_assessed_reference','owner_comparable')),
  provenance text not null check (provenance in ('owner_entered','owner_document','official_reference')),
  supersedes_id bigint references public.property_value_observations(id) on delete restrict,
  encrypted_payload text not null,
  created_at timestamptz not null default now()
);
create index if not exists property_value_observations_owner_asset_date_idx on public.property_value_observations (owner_id, property_asset_id, observed_on desc, id desc);

create table if not exists public.property_value_references (
  id bigint generated always as identity primary key,
  owner_id uuid not null references auth.users(id) on delete cascade,
  property_asset_id uuid not null references public.property_assets(id) on delete restrict,
  geography_slug text not null references public.property_geographies(slug),
  currency text not null check (currency in ('USD', 'INR')),
  base_observation_id bigint not null references public.property_value_observations(id) on delete restrict,
  result_kind text not null check (result_kind in ('indexed_reference','forecast_scenario')),
  horizon_years smallint check (horizon_years in (1,3,5)),
  model_version text not null,
  encrypted_payload text not null,
  created_at timestamptz not null default now()
);
create index if not exists property_value_references_owner_asset_created_idx on public.property_value_references (owner_id, property_asset_id, created_at desc, id desc);

alter table public.property_value_observations enable row level security;
alter table public.property_value_references enable row level security;
revoke all on public.property_value_observations, public.property_value_references from anon, authenticated;

do $$ declare t text; begin
  foreach t in array array['property_value_observations','property_value_references'] loop
    execute format('drop trigger if exists %I_append_only on public.%I', t, t);
    execute format('create trigger %I_append_only before update or delete on public.%I for each row execute function public.prevent_property_evidence_mutation()', t, t);
    execute format('drop trigger if exists %I_no_truncate on public.%I', t, t);
    execute format('create trigger %I_no_truncate before truncate on public.%I for each statement execute function public.prevent_property_evidence_truncate()', t, t);
    execute format('revoke update, delete, truncate on public.%I from service_role', t);
  end loop;
end $$;
