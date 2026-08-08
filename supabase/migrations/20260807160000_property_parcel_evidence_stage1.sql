-- Property valuation Stage 1: privacy-minimized parcel evidence only.
-- No AVM, recommendation, transaction, securities signal, or money-path output.

insert into public.property_sources
  (source_key, display_name, official_url, permitted_use, cadence, activation_state)
values
  ('maricopa-sales', 'Maricopa County Sales Affidavits',
   'https://www.mcassessor.maricopa.gov/page/data_sales/',
   'Private owner decision support; no redistribution; sales evidence is independently verified before reliance',
   'Monthly snapshot', 'active'),
  ('tcad-appraisal', 'Travis Central Appraisal District',
   'https://traviscad.org/publicinformation/',
   'Owner-selected parcel attributes and county appraisal reference; never represented as a sale or market price',
   'Certified annual plus supplement', 'active')
on conflict (source_key) do update set
  display_name = excluded.display_name,
  official_url = excluded.official_url,
  permitted_use = excluded.permitted_use,
  cadence = excluded.cadence;

create table if not exists public.property_valuation_scopes (
  id uuid primary key default gen_random_uuid(),
  market_slug text not null references public.property_geographies(slug),
  source_key text not null references public.property_sources(source_key),
  scope_kind text not null check (scope_kind in ('postal_code', 'parcel')),
  -- Postal codes are coarse public geography. Parcel values are keyed HMACs;
  -- raw parcel/account numbers never enter this table.
  scope_value text not null,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (market_slug, source_key, scope_kind, scope_value),
  check (
    (market_slug = 'phoenix' and source_key = 'maricopa-sales' and scope_kind = 'postal_code' and scope_value ~ '^[0-9]{5}$')
    or
    (market_slug = 'austin' and source_key = 'tcad-appraisal' and scope_kind = 'parcel' and scope_value ~ '^[a-f0-9]{64}$')
  )
);

create table if not exists public.property_bulk_snapshots (
  id uuid primary key default gen_random_uuid(),
  source_key text not null references public.property_sources(source_key),
  market_slug text not null references public.property_geographies(slug),
  source_release_id text not null,
  source_url text not null check (source_url ~ '^https://'),
  source_sha256 text not null check (source_sha256 ~ '^[a-f0-9]{64}$'),
  scope_fingerprint text not null check (scope_fingerprint ~ '^[a-f0-9]{64}$'),
  started_at timestamptz not null,
  completed_at timestamptz,
  outcome text not null check (outcome in ('success', 'partial', 'failed', 'no_scope')),
  rows_seen bigint not null default 0 check (rows_seen >= 0),
  rows_written bigint not null default 0 check (rows_written >= 0),
  rejection_counts jsonb not null default '{}'::jsonb,
  detail text,
  created_at timestamptz not null default now(),
  unique (source_key, source_release_id, scope_fingerprint)
);

create table if not exists public.property_parcel_snapshots (
  id bigint generated always as identity primary key,
  bulk_snapshot_id uuid not null references public.property_bulk_snapshots(id),
  source_key text not null references public.property_sources(source_key),
  market_slug text not null references public.property_geographies(slug),
  parcel_key text not null check (parcel_key ~ '^[a-f0-9]{64}$'),
  postal_code text,
  property_type text,
  valuation_year integer,
  county_appraised_value numeric check (county_appraised_value is null or county_appraised_value >= 0),
  county_assessed_value numeric check (county_assessed_value is null or county_assessed_value >= 0),
  livable_sqft numeric check (livable_sqft is null or livable_sqft >= 0),
  land_sqft numeric check (land_sqft is null or land_sqft >= 0),
  year_built integer check (year_built is null or year_built between 1700 and 2200),
  source_payload_hash text not null check (source_payload_hash ~ '^[a-f0-9]{64}$'),
  observed_at timestamptz not null default now(),
  unique (source_key, parcel_key, bulk_snapshot_id)
);

create table if not exists public.property_bulk_snapshot_events (
  id bigint generated always as identity primary key,
  bulk_snapshot_id uuid not null references public.property_bulk_snapshots(id),
  event_type text not null check (event_type in ('write_started', 'write_completed', 'write_failed')),
  rows_written bigint not null default 0 check (rows_written >= 0),
  detail text,
  created_at timestamptz not null default now()
);

create table if not exists public.property_sales (
  id bigint generated always as identity primary key,
  observed_snapshot_id uuid not null references public.property_bulk_snapshots(id),
  source_key text not null references public.property_sources(source_key),
  market_slug text not null references public.property_geographies(slug),
  parcel_key text not null check (parcel_key ~ '^[a-f0-9]{64}$'),
  event_key text not null check (event_key ~ '^[a-f0-9]{64}$'),
  postal_code text not null check (postal_code ~ '^[0-9]{5}$'),
  sale_month date not null check (extract(day from sale_month) = 1),
  deed_date date not null,
  sale_price numeric not null check (sale_price > 0),
  property_type text not null,
  deed_type text,
  deed_status text,
  assessor_code text,
  assessor_code_description text,
  source_payload_hash text not null check (source_payload_hash ~ '^[a-f0-9]{64}$'),
  observed_at timestamptz not null default now(),
  -- The same deed may be republished with a correction. Preserve each release
  -- rather than overwriting it or inventing a second transaction.
  unique (source_key, event_key, observed_snapshot_id)
);

create index if not exists property_sales_zip_month_idx
  on public.property_sales (postal_code, sale_month desc);
create index if not exists property_parcel_latest_idx
  on public.property_parcel_snapshots (market_slug, parcel_key, observed_at desc);
create index if not exists property_bulk_snapshots_latest_idx
  on public.property_bulk_snapshots (source_key, created_at desc);

alter table public.property_valuation_scopes enable row level security;
alter table public.property_bulk_snapshots enable row level security;
alter table public.property_parcel_snapshots enable row level security;
alter table public.property_sales enable row level security;
alter table public.property_bulk_snapshot_events enable row level security;

revoke all on public.property_valuation_scopes, public.property_bulk_snapshots,
  public.property_parcel_snapshots, public.property_sales from anon, authenticated;
revoke all on public.property_bulk_snapshot_events from anon, authenticated;

-- Scope configuration is mutable, but every downloaded release and normalized
-- evidence row is immutable. TRUNCATE is blocked independently from row changes.
do $$
declare t text;
begin
  foreach t in array array[
    'property_source_runs', 'property_bulk_snapshots',
    'property_parcel_snapshots', 'property_sales',
    'property_bulk_snapshot_events'
  ] loop
    execute format('drop trigger if exists %I_append_only on public.%I', t, t);
    execute format(
      'create trigger %I_append_only before update or delete on public.%I '
      'for each row execute function public.prevent_property_evidence_mutation()', t, t);
    execute format('drop trigger if exists %I_no_truncate on public.%I', t, t);
    execute format(
      'create trigger %I_no_truncate before truncate on public.%I '
      'for each statement execute function public.prevent_property_evidence_truncate()', t, t);
    execute format('revoke update, delete, truncate on public.%I from service_role', t);
  end loop;
end $$;

comment on table public.property_sales is
  'Privacy-minimized public-record sale evidence. No owner names or plaintext addresses/parcel IDs.';
comment on column public.property_parcel_snapshots.county_appraised_value is
  'County appraisal model output; reference only and never a market-price estimate.';
comment on column public.property_parcel_snapshots.county_assessed_value is
  'Tax assessment after applicable caps; reference only and never a sale or market price.';
