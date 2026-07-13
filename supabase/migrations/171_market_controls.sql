-- 171: per-market pause / trading-enable controls.
--
-- WHY: app_paused and trading_enabled lived as GLOBAL columns on the single
-- strategy_config row, so a market-specific circuit breaker (India NAV drawdown,
-- US kill switch) flipped ONE shared flag and every consumer — US *and* India
-- research/paper-trade/trader/execute-order — read it. Result: India's phantom
-- drawdown paused US research (2026-07-13), and a real US trip would halt India.
--
-- market_controls holds one row per market. A market is paused / trading-disabled
-- if EITHER the legacy GLOBAL master (strategy_config.app_paused/trading_enabled)
-- OR its own row says so — so the global switch still works as a "stop
-- everything" master-kill, while a market's own breaker isolates to that market.
-- Seeded from the current global flags so no state is lost at cutover.

create table if not exists public.market_controls (
  market          text primary key check (market in ('us', 'india')),
  paused          boolean not null default false,
  trading_enabled boolean not null default true,
  paused_reason   text,
  paused_at       timestamptz,
  updated_at      timestamptz not null default now()
);

-- Carry current global state into both market rows (idempotent).
insert into public.market_controls (market, paused, trading_enabled)
select m,
       coalesce((select app_paused      from public.strategy_config limit 1), false),
       coalesce((select trading_enabled from public.strategy_config limit 1), true)
from unnest(array['us', 'india']) as m
on conflict (market) do nothing;

alter table public.market_controls enable row level security;

-- Owner reads directly; all writes go through the service client (bypasses RLS).
drop policy if exists market_controls_owner_read on public.market_controls;
create policy market_controls_owner_read
  on public.market_controls for select to authenticated
  using ((auth.jwt() ->> 'email') = 'vterminater@gmail.com');
