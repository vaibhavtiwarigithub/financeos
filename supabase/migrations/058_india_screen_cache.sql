-- Phase 5.5: India full-market scanner cache.
-- On-demand scanning the full ~2000-name NSE list via Yahoo per request is far
-- too slow, so a nightly cron (POST /api/scan/india/refresh) pre-scores the full
-- NSE universe (from NSE's EQUITY_L.csv) into this table, and the Scanner reads
-- it instantly. Lifts the India scan from the ~NIFTY-100 stub to the full market.
-- Additive + idempotent.

create table if not exists india_screen_cache (
  symbol        text primary key,          -- ".NS" ticker
  name          text,
  price         numeric,
  pe            numeric,
  rsi           numeric,
  ema50         numeric,
  above_ma50    boolean,
  profit_margin numeric,
  roe           numeric,
  rev_growth    numeric,
  sector        text,
  scored_at     timestamptz default now()
);

alter table india_screen_cache disable row level security;
create index if not exists india_screen_sector_idx on india_screen_cache(sector);
create index if not exists india_screen_scored_idx on india_screen_cache(scored_at desc);
