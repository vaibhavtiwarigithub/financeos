-- Decision Journal had no market column at all, so it could never be split
-- by the US/India switcher (a real gap flagged during a market-switcher
-- wiring audit, 2026-07-06).
--
-- CRITICAL pre-existing bug found while writing this migration:
-- decision_journal.signal_id and .paper_trade_id were typed bigint, but
-- agent_signals.id and paper_trades.id are uuid. Every write site inserts
-- the real uuid signal/trade id into these columns (e.g.
-- app/api/agents/paper-trade/route.ts: `signal_id: signal.id`), which fails
-- with "invalid input syntax for type bigint" on every single insert. This
-- has been failing 100% silently since decision_journal was created --
-- confirmed live: 0 of 7 existing rows have signal_id or paper_trade_id
-- populated, across every entry_type including paper_fill/paper_exit, which
-- always pass one of these. Fixed here (safe: no valid data to lose, both
-- columns are 100% null today).

alter table public.decision_journal alter column signal_id type uuid using signal_id::text::uuid;
alter table public.decision_journal alter column paper_trade_id type uuid using paper_trade_id::text::uuid;

alter table public.decision_journal add column if not exists market text check (market in ('us', 'india'));

update public.decision_journal dj
set market = coalesce(
  (select s.market from public.agent_signals s where s.id = dj.signal_id),
  (select t.market from public.paper_trades t where t.id = dj.paper_trade_id)
)
where dj.market is null and (dj.signal_id is not null or dj.paper_trade_id is not null);
