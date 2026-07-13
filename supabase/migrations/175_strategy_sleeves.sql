-- 175: asset-class allocation sleeves (SHIPPED OFF).
--
-- Foundation for the allocation layer (features/asset-allocation). Defines named
-- sleeves per market with target + band weights; a deterministic allocator
-- (lib/allocation/allocator.ts) maps macro regime → sleeve targets within the
-- bands. SHIPPED OFF: strategy_config.allocation_enabled default false → nothing
-- consumes these until the owner enables it, so zero behaviour change today.
-- Genome-evolution, the slow rebalancer, and paper-trade sizing wiring are a
-- separate, validated follow-up (money path).

create table if not exists public.strategy_sleeves (
  market      text not null check (market in ('us', 'india')),
  sleeve      text not null,                         -- equity | defensive_etf | cash | leveraged
  target_pct  numeric not null default 0,            -- current target weight (0-100)
  min_pct     numeric not null default 0,            -- hard lower band
  max_pct     numeric not null default 100,          -- hard upper band
  instruments jsonb   not null default '[]'::jsonb,  -- ETF tickers for the sleeve (equity/cash have none)
  enabled     boolean not null default true,         -- leveraged ships disabled
  updated_at  timestamptz not null default now(),
  primary key (market, sleeve)
);

alter table public.strategy_sleeves enable row level security;
drop policy if exists strategy_sleeves_owner_read on public.strategy_sleeves;
create policy strategy_sleeves_owner_read on public.strategy_sleeves
  for select to authenticated using ((auth.jwt() ->> 'email') = 'vterminater@gmail.com');

-- Default sleeves (owner-tunable). Leveraged OFF + capped. Cash is the residual.
insert into public.strategy_sleeves (market, sleeve, target_pct, min_pct, max_pct, instruments, enabled) values
  ('us','equity',        70, 0, 90, '[]'::jsonb, true),
  ('us','defensive_etf', 20, 0, 50, '["SHY","IEF","TLT","GLD"]'::jsonb, true),
  ('us','cash',          10, 5,100, '[]'::jsonb, true),
  ('us','leveraged',      0, 0, 15, '["SSO","QLD"]'::jsonb, false),
  ('india','equity',        70, 0, 90, '[]'::jsonb, true),
  ('india','defensive_etf', 20, 0, 50, '["LIQUIDBEES.NS","GOLDBEES.NS"]'::jsonb, true),
  ('india','cash',          10, 5,100, '[]'::jsonb, true)
on conflict (market, sleeve) do nothing;

-- Master off-switch (default OFF → allocator is inert until the owner turns it on).
alter table public.strategy_config add column if not exists allocation_enabled boolean not null default false;
