-- Markets overview: one provider resolution per session, not per request window.
--
-- WHY NOT READ price_cache INSTEAD. That was tried and rejected on production
-- evidence (recorded in tests/markets-overview.test.ts, 2026-07-17): the cache
-- head is ragged across symbols, its newest ALIGNED session is staler than what
-- the grouped endpoint serves, and reading it re-opens cross-session mixing —
-- rendering one symbol's newer close against another's older one. The grouped
-- source stays; only the CADENCE changes.
--
-- The route served daily values (close vs prior close, immutable once published)
-- behind a 5-minute route cache and a 5-minute per-instance memory cache. That
-- is up to ~288 refresh windows a day, across however many serverless instances
-- are warm, for numbers that move once. This table makes the result durable and
-- shared: once a session's overview is stored, every later request in that
-- session reads the row and touches no provider at all.
--
-- Keyed by the RESOLVED session date, not by wall-clock day, so a payload can
-- never outlive the session it describes: the route compares the stored
-- session_date against expectedLatestSessionDate() and re-resolves when a newer
-- session should already have published.

create table if not exists public.market_overview_snapshots (
  market       text not null check (market in ('us')),
  session_date date not null,
  payload      jsonb not null,
  fetched_at   timestamptz not null default now(),
  primary key (market, session_date)
);

comment on table public.market_overview_snapshots is
  'Durable per-session cache of the /api/markets/overview payload. Written by the route on a miss; read by every other request in the same session. Derived market data only - no positions, orders or account values.';

create index if not exists market_overview_snapshots_recent_idx
  on public.market_overview_snapshots (market, session_date desc);

alter table public.market_overview_snapshots enable row level security;

-- Derived public market data, but there is no reason for a client to read it
-- directly: the route serves it. Owner-pinned read for debugging; service-role
-- writes (service_role has rolbypassrls, so it needs no policy).
drop policy if exists "market_overview_snapshots_owner_read" on public.market_overview_snapshots;
create policy "market_overview_snapshots_owner_read" on public.market_overview_snapshots
  for select to authenticated
  using (((select auth.jwt()) ->> 'email'::text) = 'vterminater@gmail.com'::text);
