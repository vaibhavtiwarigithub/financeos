-- Crypto paper trading pool (Stage 3, approved 2026-09-16 — owner-directed
-- evidence-gate override; ~12/20 MIN_PREDICTIVE_DATES sessions at the time of
-- approval). See features/robinhood-crypto/FEATURE_ARCHITECTURE.md.
--
-- Reuses paper_portfolio/paper_positions/paper_trades/paper_performance's
-- free-text `market` column (verified: none of the 4 carry a CHECK constraint)
-- with a THIRD value, 'crypto'. Every existing consumer of these tables filters
-- market IN ('us','india') explicitly (verified by repo-wide grep — no reader
-- selects across all markets unfiltered), so a 'crypto' row is invisible to
-- every existing equity/India NAV, P&L, learning, or benchmark computation
-- without any code change there. Isolation (doc §2.5, acceptance criterion #3:
-- "crypto's paper NAV never sums into the US equity paper pool's NAV") holds by
-- construction, not by an added filter.
--
-- Scoring/research keeps crypto tagged market='us' + instrument_family='crypto'
-- (lib/scoring/instrument-taxonomy.ts) — UNCHANGED. This migration touches only
-- the isolated paper-execution ledger plus market_controls (kill-switch pause
-- state for the new crypto book), never the 30+ tables whose market CHECK
-- constraint the feature doc deliberately left at ('us','india') for the
-- scoring/session layer.

insert into paper_portfolio (cash_balance, nav, market, currency)
select 10000, 10000, 'crypto', 'USD'
where not exists (select 1 from paper_portfolio where market = 'crypto');

-- market_controls.market is PRIMARY KEY + CHECK (market in ('us','india'))
-- (migration 171) — widen to admit the crypto book's own pause/kill-switch
-- state. Constraint name discovered dynamically rather than assumed, since it
-- was auto-named by Postgres from an inline column CHECK.
do $$
declare
  con record;
begin
  for con in
    select conname from pg_constraint
    where conrelid = 'public.market_controls'::regclass
      and contype = 'c'
      and pg_get_constraintdef(oid) ilike '%market%us%india%'
  loop
    execute format('alter table public.market_controls drop constraint %I', con.conname);
  end loop;
end $$;

alter table public.market_controls
  add constraint market_controls_market_check check (market in ('us', 'india', 'crypto'));

insert into public.market_controls (market, paused, trading_enabled)
select 'crypto', false, true
where not exists (select 1 from public.market_controls where market = 'crypto');

-- decision_journal.market carries the same CHECK (migration 084). The
-- execute_paper_exit RPC (20260817180000_w2_full_partial_exit_ledger.sql)
-- unconditionally inserts a decision_journal row on every close using the
-- position's own market — with only ('us','india') allowed, the very first
-- crypto paper exit would fail this CHECK and roll back the whole exit
-- (position delete, trade close, cash credit) inside one transaction. Found
-- by reading the RPC body before shipping the crypto exit route, not by
-- discovering it in production.
do $$
declare
  con record;
begin
  for con in
    select conname from pg_constraint
    where conrelid = 'public.decision_journal'::regclass
      and contype = 'c'
      and pg_get_constraintdef(oid) ilike '%market%us%india%'
  loop
    execute format('alter table public.decision_journal drop constraint %I', con.conname);
  end loop;
end $$;

alter table public.decision_journal
  add constraint decision_journal_market_check check (market in ('us', 'india', 'crypto') or market is null);

-- Cloud delivery — never a Windows Task Scheduler/local-dev-server dependency.
-- `kairos_call_agent` is the existing Vault-backed scheduler bridge; it holds
-- CRON_SECRET in Supabase Vault instead of baking credentials into cron text.
-- Entries run after the US research window and after the declared 00:00 UTC
-- crypto daily-bar cutoff respectively.  Crypto is paper-only; these routes
-- never call a live broker order API.
do $$
begin
  begin perform cron.unschedule('kairos-crypto-paper-trade'); exception when others then null; end;
  begin perform cron.unschedule('kairos-crypto-position-monitor'); exception when others then null; end;
end $$;

select cron.schedule(
  'kairos-crypto-paper-trade',
  '30 14 * * 1-5',
  $$select public.kairos_call_agent('/api/agents/crypto-paper-trade', '{}'::jsonb, 'POST', 60000)$$
);

select cron.schedule(
  'kairos-crypto-position-monitor',
  '30 0 * * *',
  $$select public.kairos_call_agent('/api/agents/crypto-position-monitor', '{}'::jsonb, 'POST', 60000)$$
);
