-- Stock Context feature (features/stock-context): a lightweight, read-only
-- "what is this stock" cache. One row per (symbol, market). Display-only —
-- NEVER read by scoring/sizing/gate/order code. All fields except the PK are
-- nullable: we store whatever the free provider returns (Finnhub for US, Yahoo
-- for India) and leave the rest blank.
--
-- SECURITY (Supabase Security Advisor): a new PUBLIC table with RLS OFF is an
-- ERROR (readable/writable through the anon key). This table ships RLS-ON from
-- migration #1, with a single authenticated-SELECT policy: anon is denied,
-- the logged-in owner can read, and the server writes via the service_role key
-- which BYPASSES RLS. Same pattern as newsletters / earnings_calendar
-- (migration 20260715120000).

create table if not exists public.symbol_profiles (
  symbol            text        not null,
  market            text        not null check (market in ('us', 'india')),
  company_name      text,
  one_liner         text,
  sector            text,
  industry          text,
  exchange          text,
  market_cap_tier   text        check (market_cap_tier in ('mega', 'large', 'mid', 'small', 'micro')),
  next_earnings_date date,
  peers             text[],
  source            text,
  updated_at        timestamptz not null default now(),
  primary key (symbol, market)
);

-- Freshness lookups by (symbol, market) hit the PK; the backfill also scans by
-- updated_at to find stale rows.
create index if not exists symbol_profiles_updated_at_idx
  on public.symbol_profiles (updated_at);

-- RLS: deny anon, allow authenticated (owner) SELECT. service_role bypasses RLS
-- for writes (backfill route). No INSERT/UPDATE policy is defined on purpose —
-- only the server (service_role) may write.
alter table public.symbol_profiles enable row level security;

drop policy if exists symbol_profiles_authenticated_read on public.symbol_profiles;
create policy symbol_profiles_authenticated_read
  on public.symbol_profiles for select to authenticated using (true);
