-- Price provenance and restatement detection.
--
-- WHY. A "sealed" historical replay records a dataset fingerprint and claims the
-- result is frozen. That claim is false if the underlying bars can change
-- afterwards. Adjusted history IS restated -- a split or dividend rewrites every
-- prior close -- and `price_cache` had no provider, no basis and no version, so
-- a restatement was indistinguishable from the original data. The sealed result
-- would silently stop matching its own inputs with nothing to detect it.
--
-- Two additions:
--   1. Provenance columns, so a replay records WHAT it consumed.
--   2. An append-only restatement log, so a later change to a bar the replay
--      already used is provable rather than invisible.
--
-- Existing 72,049 rows predate provenance and are labelled 'unknown' rather than
-- guessed. 'unknown' is the honest value and it correctly disqualifies those
-- bars from a replay that requires a known basis.
--
-- APPLIED to production 2026-09-01 and verified: a real value change logs with
-- close_delta_pct, an IDENTICAL rewrite does not log, and UPDATE/DELETE on the
-- log are refused.

alter table public.price_cache
  add column if not exists provider text not null default 'unknown',
  -- Whether closes are split/dividend adjusted. Determines whether history can
  -- be restated under the operator's feet.
  add column if not exists price_basis text not null default 'unknown',
  add column if not exists provenance_version text not null default 'v0_unprovenanced',
  add column if not exists first_seen_at timestamptz not null default now();

alter table public.price_cache
  drop constraint if exists price_cache_price_basis_check;
alter table public.price_cache
  add constraint price_cache_price_basis_check
  check (price_basis = any (array['adjusted','raw','unknown']));

-- Append-only record of every value change to a bar that already existed.
create table if not exists public.price_cache_restatements (
  id bigserial primary key,
  symbol text not null,
  date text not null,
  old_open numeric, old_high numeric, old_low numeric, old_close numeric, old_volume bigint,
  new_open numeric, new_high numeric, new_low numeric, new_close numeric, new_volume bigint,
  old_provider text, new_provider text,
  old_price_basis text, new_price_basis text,
  -- Relative change in close. The field a replay cares about most.
  close_delta_pct numeric,
  detected_at timestamptz not null default now()
);

create index if not exists price_cache_restatements_symbol_idx
  on public.price_cache_restatements (symbol, date, detected_at desc);
create index if not exists price_cache_restatements_detected_idx
  on public.price_cache_restatements (detected_at desc);

alter table public.price_cache_restatements enable row level security;
revoke all on public.price_cache_restatements from anon, authenticated;
grant select on public.price_cache_restatements to authenticated;
create policy price_cache_restatements_owner_read on public.price_cache_restatements
  for select to authenticated
  using ((select auth.jwt() ->> 'email') = 'vterminater@gmail.com');
create policy price_cache_restatements_service_all on public.price_cache_restatements
  for all to service_role using (true) with check (true);

create or replace function public.price_cache_restatements_append_only()
returns trigger language plpgsql as $$
begin
  raise exception 'price_cache_restatements is append-only';
end $$;

drop trigger if exists price_cache_restatements_no_mutate_trg on public.price_cache_restatements;
create trigger price_cache_restatements_no_mutate_trg
  before update or delete on public.price_cache_restatements
  for each row execute function public.price_cache_restatements_append_only();

-- Log a restatement whenever an EXISTING bar's values actually change.
-- A re-write of identical values is not a restatement and is not logged, so the
-- log stays a record of real changes rather than of upsert traffic.
create or replace function public.price_cache_detect_restatement()
returns trigger language plpgsql as $$
begin
  if new.open is distinct from old.open
     or new.high is distinct from old.high
     or new.low is distinct from old.low
     or new.close is distinct from old.close
     or new.volume is distinct from old.volume
     or new.provider is distinct from old.provider
     or new.price_basis is distinct from old.price_basis then
    insert into public.price_cache_restatements (
      symbol, date,
      old_open, old_high, old_low, old_close, old_volume,
      new_open, new_high, new_low, new_close, new_volume,
      old_provider, new_provider, old_price_basis, new_price_basis,
      close_delta_pct)
    values (
      old.symbol, old.date,
      old.open, old.high, old.low, old.close, old.volume,
      new.open, new.high, new.low, new.close, new.volume,
      old.provider, new.provider, old.price_basis, new.price_basis,
      case when old.close is not null and old.close <> 0
           then ((new.close - old.close) / old.close) * 100 else null end);
    -- Preserve the original discovery time across restatements.
    new.first_seen_at := old.first_seen_at;
  end if;
  return new;
end $$;

drop trigger if exists price_cache_detect_restatement_trg on public.price_cache;
create trigger price_cache_detect_restatement_trg
  before update on public.price_cache
  for each row execute function public.price_cache_detect_restatement();

comment on column public.price_cache.price_basis is
  'adjusted = split/dividend adjusted and therefore RESTATABLE; raw = as-traded; unknown = predates provenance and must not back a sealed replay.';
comment on table public.price_cache_restatements is
  'Append-only log of real value changes to existing bars. A sealed replay is only trustworthy if no restatement touched its window after it ran.';
