-- 126 — Paper-fill freshness + claim ownership (additive only)
--
-- Context: US paper fills come only from research/cron chaining POST
-- /api/agents/paper-trade at its end. When the US research run hangs before
-- that chain, no fill happens — while stale `pending` long signals pile up
-- (some 10+ days old). The fix adds standalone per-market paper-trade crons,
-- but a cron must NOT fill stale signals. This migration is the prerequisite:
--
--   1. claim ownership columns so a run reverts ONLY the rows it claimed
--      (claim_run_id) — safe against a concurrent chain + cron both running.
--   2. market_trading_day_start(market): the market-local calendar-day start
--      (America/New_York for US, Asia/Kolkata for India), DST-correct. Used by
--      the route for the same-trading-day freshness guard AND the daily paper
--      notional cap boundary (replacing a UTC-midnight approximation).
--   3. indexes for the two new hot paths: selecting fresh pending long signals,
--      and sweeping stale `claiming` rows.
--
-- All additive. No column drops, no data mutation, no ledger writes.
-- agent_signals.status is free-text (no CHECK/enum), so the route's new
-- terminal value 'expired' needs no constraint change.

alter table public.agent_signals
  add column if not exists claimed_at   timestamptz,
  add column if not exists claim_run_id uuid;

comment on column public.agent_signals.claimed_at is
  'When a paper-trade run set status=claiming. Cleared when the row returns to pending or reaches paper_traded.';
comment on column public.agent_signals.claim_run_id is
  'agent_runs.id of the paper-trade run that claimed this row. A run reverts only rows where claim_run_id = its own run id.';

-- Market-local calendar-day start as a timestamptz instant (DST-correct).
-- Pattern mirrors migration 111 reserve-budget: (now() at tz) truncated to day,
-- then reinterpreted back into the same tz to get the real UTC instant.
create or replace function public.market_trading_day_start(p_market text)
returns timestamptz
language sql
stable
as $$
  select case
    when p_market = 'india'
      then date_trunc('day', now() at time zone 'Asia/Kolkata')     at time zone 'Asia/Kolkata'
    else date_trunc('day', now() at time zone 'America/New_York') at time zone 'America/New_York'
  end
$$;

comment on function public.market_trading_day_start(text) is
  'Start of the current market-local calendar day as a timestamptz. india=Asia/Kolkata, else America/New_York. Used for same-trading-day signal freshness and the daily paper notional cap window.';

-- Fresh pending long signals, ordered by score — the paper-trade candidate query.
create index if not exists idx_agent_signals_pending_long_fresh
  on public.agent_signals (market, analyst_score desc, created_at desc)
  where status = 'pending' and direction = 'long';

-- Stale `claiming` rows — the future watchdog sweep (Phase 3) and any manual cleanup.
create index if not exists idx_agent_signals_claiming
  on public.agent_signals (claimed_at)
  where status = 'claiming';
