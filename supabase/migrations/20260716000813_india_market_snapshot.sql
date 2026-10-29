-- India Markets snapshot — durable cache table (display data only, off the money path).
--
-- Backs the owner/cron-gated /api/markets/india boundary. Each row is a FROZEN
-- IndiaMarketsSnapshot (indices + NSE sector indices + NIFTY-50 breadth) with
-- provenance (source/observedAt/quality) and an overall status. The Markets page
-- reads the latest row cache-first instead of the browser calling Yahoo directly.
--
-- ISOLATION: this table is India-only and entirely separate from `price_cache`
-- (US ETF OHLC). India data is never written to price_cache and US data is never
-- written here — the two caches can never cross-read. INR-denominated by contract.
--
-- Additive + idempotent. No RLS (service-role writes; the GET route reads via the
-- server, returning only display-safe market data — no personal/account data).

create table if not exists india_market_snapshot (
  id          bigint generated always as identity primary key,
  as_of       text not null,               -- India session date (YYYY-MM-DD, IST)
  fetched_at  timestamptz not null default now(),
  status      text not null,               -- 'complete' | 'partial' | 'unavailable'
  snapshot    jsonb not null,              -- full IndiaMarketsSnapshot payload
  created_at  timestamptz not null default now()
);

-- RLS ON (corrected 2026-07-15 via 20260715162000_india_market_snapshot_enable_rls):
-- a public table with RLS disabled is anon-readable via the API key. service_role
-- (cron + route) bypasses RLS; authenticated (owner) gets read.
alter table india_market_snapshot enable row level security;
drop policy if exists india_market_snapshot_authenticated_read on india_market_snapshot;
create policy india_market_snapshot_authenticated_read
  on india_market_snapshot for select to authenticated using (true);

create index if not exists india_market_snapshot_fetched_idx
  on india_market_snapshot(fetched_at desc);
