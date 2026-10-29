-- Stock Context symbol-profiles backfill — schedule.
--
-- Fills `symbol_profiles` for watchlist symbols lacking a FRESH (<30d) profile and
-- backfills `watchlist.company_name` where null, from Finnhub/Yahoo. The route
-- (/api/agents/symbol-profiles/backfill) is owner-or-cron gated, bounded by a
-- ~90s wall-clock budget (idempotent — fresh profiles skipped, the rest re-deferred
-- to the next run), and DISPLAY-ONLY — never on the money/scoring path.
--
-- One weekday pre-market tick at 11:40 UTC (assuming EDT — shift 1h at the Nov
-- change, consistent with the other kairos-* jobs). Chosen slot is idle: it sits
-- after the India pre-market burst (research/briefing/monitor all fire by ~04:50 &
-- 11:15 UTC) and well before the US research run (13:00 UTC) + morning briefing
-- (14:00 UTC), colliding with no existing job. No ?market param → both US + India
-- watchlist symbols are covered in one bounded pass.

do $$
begin
  begin
    perform cron.unschedule('kairos-symbol-profiles-backfill');
  exception when others then null;
  end;
end $$;

select cron.schedule('kairos-symbol-profiles-backfill', '40 11 * * 1-5',
  $$select public.kairos_call_agent('/api/agents/symbol-profiles/backfill', '{}'::jsonb, 'POST', 115000)$$);
