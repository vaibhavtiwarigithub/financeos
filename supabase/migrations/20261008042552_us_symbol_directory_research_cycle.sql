-- Daily, evidence-only US listing-directory delta. One compact snapshot is kept;
-- we do not retain a full market directory for every day.
begin;
alter table public.listing_candidates
  drop constraint if exists listing_candidates_state_check;
alter table public.listing_candidates
  add constraint listing_candidates_state_check check (state in
    ('pre_listing','announced','directory_observed','listed_observing','paper_admitted',
     'withdrawn','postponed','rejected','delisted'));
alter table public.listing_candidates
  add column if not exists last_research_attempt_at timestamptz;

create index if not exists listing_candidates_research_rotation_idx
  on public.listing_candidates(market, state, last_research_attempt_at nulls first, first_seen_at);

create table if not exists public.us_symbol_directory_snapshot (
  id text primary key check (id = 'us'),
  listing_keys text[] not null,
  source_as_of date not null,
  source_hash text not null,
  observed_at timestamptz not null,
  updated_at timestamptz not null default now()
);
alter table public.us_symbol_directory_snapshot enable row level security;
revoke all on public.us_symbol_directory_snapshot from public, anon, authenticated;
grant select, insert, update on public.us_symbol_directory_snapshot to service_role;

commit;
