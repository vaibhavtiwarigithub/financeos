-- Per-symbol return-observation contract — the MEASUREMENT PREREQUISITE for
-- correlation-aware construction (features/correlation-aware-construction/
-- FEATURE_ARCHITECTURE.md §0, "Required prerequisite", item 1).
--
-- Holding Risk computes pairwise correlation IN MEMORY among already-held names and
-- persists only per-name cluster summaries. A new candidate is never in that run, so
-- no candidate-to-book correlation exists to consume at entry. This table is where the
-- evidence needed to eventually MEASURE that correlation starts accumulating. It
-- activates nothing: no scoring/sizing/eligibility/order/exit path reads it.
--
-- Rows are appended by lib/data/return-observations.ts, piggybacked on candles the
-- ResearchAgent already fetched for scoring. No extra provider call.
--
-- POINT-IN-TIME: available_at is when we could first have known the row. The builder
-- drops any bar dated after that instant before computing anything, so a value that
-- we could not have known at available_at is not storable.
--
-- BETA HONESTY: benchmark_beta is NULL unless genuinely measured against the market's
-- own benchmark (us → SPY, india → ^NSEI) over >= 60 shared sessions. A sector proxy
-- is NEVER written here; beta_unmeasurable_reason records why it is absent instead.

create table if not exists public.symbol_return_observations (
  id                          bigserial   primary key,
  symbol                      text        not null,
  market                      text        not null check (market in ('us', 'india')),
  as_of                       date        not null,
  available_at                timestamptz not null default now(),
  source                      text,
  window_start                date        not null,
  window_end                  date        not null,
  observation_count           integer     not null check (observation_count >= 0),
  daily_vol                   numeric,
  benchmark_symbol            text,
  benchmark_beta              numeric,
  benchmark_overlap_sessions  integer     not null default 0,
  beta_unmeasurable_reason    text        check (beta_unmeasurable_reason in (
                                            'no_benchmark_for_market',
                                            'benchmark_series_unavailable',
                                            'insufficient_overlap',
                                            'benchmark_zero_variance'
                                          )),
  input_fingerprint           text        not null,
  created_at                  timestamptz not null default now(),

  -- The window must end on the session the row is as-of, and must not start after it.
  constraint symbol_return_observations_window_ck check (window_start <= window_end and window_end = as_of),
  -- PIT floor at the DB level: a row can never claim a session later than the instant
  -- it says it became knowable.
  constraint symbol_return_observations_pit_ck check (as_of <= (available_at at time zone 'utc')::date),
  -- Beta and its absence-reason are mutually exclusive: exactly one is present.
  constraint symbol_return_observations_beta_ck check (
    (benchmark_beta is not null and beta_unmeasurable_reason is null)
    or (benchmark_beta is null and beta_unmeasurable_reason is not null)
  )
);

-- Idempotency: a re-run over identical bars fingerprints identically and appends
-- nothing. Also the dedup key the capture path's insert conflicts against.
create unique index if not exists symbol_return_observations_fingerprint_uidx
  on public.symbol_return_observations (symbol, market, input_fingerprint);

-- Coverage report scans by (market, symbol) over time; PIT reads filter available_at.
create index if not exists symbol_return_observations_market_symbol_idx
  on public.symbol_return_observations (market, symbol, as_of desc);
create index if not exists symbol_return_observations_available_at_idx
  on public.symbol_return_observations (available_at desc);

-- THIS IS EVIDENCE: append-only. Blocking UPDATE/DELETE in a trigger means a stored
-- observation can never be quietly rewritten to match a later belief.
-- search_path pinned: an unpinned search_path on a trigger function is a Security
-- Advisor WARN (0011_function_search_path_mutable).
create or replace function public.symbol_return_observations_immutable()
returns trigger language plpgsql set search_path = '' as $$
begin
  raise exception 'symbol_return_observations is append-only (evidence)';
end;
$$;

drop trigger if exists symbol_return_observations_no_update on public.symbol_return_observations;
create trigger symbol_return_observations_no_update
  before update or delete on public.symbol_return_observations
  for each row execute function public.symbol_return_observations_immutable();

-- SECURITY (Supabase Security Advisor): a new PUBLIC table with RLS OFF is an ERROR
-- (readable/writable through the anon key). RLS ships ON from migration #1 with a
-- single authenticated-SELECT policy: anon denied, logged-in owner reads, and the
-- server writes via service_role which BYPASSES RLS. No INSERT/UPDATE policy on
-- purpose — only the server may append. Same pattern as symbol_profiles /
-- earnings_consensus_snapshots.
alter table public.symbol_return_observations enable row level security;

drop policy if exists symbol_return_observations_authenticated_read on public.symbol_return_observations;
create policy symbol_return_observations_authenticated_read
  on public.symbol_return_observations for select to authenticated using (true);
