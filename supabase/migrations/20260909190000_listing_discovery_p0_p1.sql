-- Evidence-only new-listing discovery.  Nothing here is a watchlist, signal,
-- paper-position, or order input.  P2 admission assessments remain deliberately
-- absent until their separate architecture/approval gate.
begin;

alter table public.broker_instrument_preflights
  add column if not exists purpose text not null default 'execution_attempt';
update public.broker_instrument_preflights
  set purpose = 'execution_attempt'
  where purpose is null;
alter table public.broker_instrument_preflights
  drop constraint if exists broker_instrument_preflights_purpose_check;
alter table public.broker_instrument_preflights
  add constraint broker_instrument_preflights_purpose_check
  check (purpose in ('execution_attempt', 'candidate_probe'));

create table if not exists public.listing_candidates (
  id bigint generated always as identity primary key,
  market text not null check (market in ('us','india')),
  issuer_key text not null,
  listing_key text not null,
  symbol text,
  company_name text not null,
  exchange text,
  instrument_type text not null default 'unknown' check (instrument_type in
    ('operating_company','adr','direct_listing','etf','closed_end_fund','spac','unit','warrant','preferred','unknown')),
  state text not null check (state in
    ('pre_listing','announced','listed_observing','paper_admitted','withdrawn','postponed','rejected','delisted')),
  announced_at timestamptz,
  first_trade_date date,
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  source text not null,
  source_event_id text not null,
  source_url text not null,
  source_payload_hash text not null,
  latest_preflight_id bigint references public.broker_instrument_preflights(id),
  admitted_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (market, listing_key)
);
create index if not exists listing_candidates_market_state_seen_idx
  on public.listing_candidates(market, state, last_seen_at desc);

create table if not exists public.listing_candidate_events (
  id bigint generated always as identity primary key,
  candidate_id bigint not null references public.listing_candidates(id),
  event_type text not null check (event_type in ('filing_discovered','listing_observed','state_transition','broker_probe','research_refresh','source_unavailable')),
  event_at timestamptz not null default now(),
  effective_at timestamptz,
  prior_state text,
  next_state text,
  source text not null,
  source_event_id text not null,
  source_url text not null,
  source_payload_hash text not null,
  reason_code text,
  calculations jsonb not null default '{}'::jsonb,
  code_version text not null,
  created_at timestamptz not null default now(),
  unique (candidate_id, event_type, source, source_event_id, source_payload_hash)
);
create index if not exists listing_candidate_events_candidate_event_idx
  on public.listing_candidate_events(candidate_id, event_at desc);

create table if not exists public.issuer_filings (
  id bigint generated always as identity primary key,
  candidate_id bigint references public.listing_candidates(id),
  cik text not null,
  accession_number text not null,
  form text not null,
  filed_at date not null,
  accepted_at timestamptz,
  effective_at timestamptz,
  primary_document_url text not null,
  issuer_name text not null,
  document_hash text not null,
  retrieved_at timestamptz not null default now(),
  parser_version text not null,
  quality_state text not null check (quality_state in ('metadata_only','retrieved','unavailable','invalid')),
  structured_payload jsonb not null default '{}'::jsonb,
  supersedes_accession text,
  created_at timestamptz not null default now(),
  unique (accession_number, document_hash)
);
create index if not exists issuer_filings_candidate_filed_idx
  on public.issuer_filings(candidate_id, filed_at desc);
create index if not exists issuer_filings_cik_filed_idx
  on public.issuer_filings(cik, filed_at desc);

alter table public.listing_candidates enable row level security;
alter table public.listing_candidate_events enable row level security;
alter table public.issuer_filings enable row level security;

create policy listing_candidates_owner_read on public.listing_candidates
  for select to authenticated using (((select auth.jwt()) ->> 'email') = 'vterminater@gmail.com');
create policy listing_candidate_events_owner_read on public.listing_candidate_events
  for select to authenticated using (((select auth.jwt()) ->> 'email') = 'vterminater@gmail.com');
create policy issuer_filings_owner_read on public.issuer_filings
  for select to authenticated using (((select auth.jwt()) ->> 'email') = 'vterminater@gmail.com');

revoke all on public.listing_candidates, public.listing_candidate_events, public.issuer_filings from public, anon, authenticated;
grant select on public.listing_candidates, public.listing_candidate_events, public.issuer_filings to authenticated;
grant select, insert, update on public.listing_candidates to service_role;
grant select, insert on public.listing_candidate_events, public.issuer_filings to service_role;

create or replace function public.reject_listing_evidence_mutation()
returns trigger language plpgsql set search_path = pg_catalog, public as $$
begin raise exception 'listing discovery evidence is append-only'; end;
$$;
revoke all on function public.reject_listing_evidence_mutation() from public, anon, authenticated;
create trigger listing_candidate_events_no_mutate before update or delete on public.listing_candidate_events
  for each row execute function public.reject_listing_evidence_mutation();
create trigger listing_candidate_events_no_truncate before truncate on public.listing_candidate_events
  for each statement execute function public.reject_listing_evidence_mutation();
create trigger issuer_filings_no_mutate before update or delete on public.issuer_filings
  for each row execute function public.reject_listing_evidence_mutation();
create trigger issuer_filings_no_truncate before truncate on public.issuer_filings
  for each statement execute function public.reject_listing_evidence_mutation();

do $$ begin perform cron.unschedule('kairos-listing-discovery-us'); exception when others then null; end $$;
select cron.schedule(
  'kairos-listing-discovery-us', '35 23 * * 1-5',
  $$select public.kairos_call_agent('/api/agents/listing-discovery?market=us', '{}'::jsonb, 'POST', 60000)$$
);

commit;
