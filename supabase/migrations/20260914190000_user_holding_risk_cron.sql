-- Per-User (guest) Risk Analytics — pg_cron schedule.
-- Spec: features/per-user-broker-risk/FEATURE_ARCHITECTURE.md §4 (Phase 2).
--
-- Fires POST /api/agents/user-holding-risk?market=<market> once per weekday,
-- 15 minutes AFTER the owner's own `kairos-holding-risk-<market>` job. The
-- offset is deliberate: the two jobs share the Yahoo candle source, and the
-- owner's book is the one that must not be delayed by a guest fan-out.
--
-- Timing (UTC, EDT summer — shift the US job 1h at the Nov EST changeover):
--   India: owner runs 11:00 UTC, this runs 11:15 UTC (16:45 IST), after close.
--   US:    owner runs 21:30 UTC, this runs 21:45 UTC (17:45 ET), after close.
--
-- COST. This job fans out per CONNECTED GUEST, so its cost was settled in code
-- rather than left to a schedule: `lib/risk/guest-risk.ts` imports only the
-- keyless Yahoo candle endpoint and never the metered fallback chain (Massive,
-- EODHD, TwelveData, Alpha Vantage), and calls no LLM. A guest therefore cannot
-- consume provider budget no matter what they hold; a symbol Yahoo cannot serve
-- is recorded as UNCOVERED with its correlation reported unknown. What does
-- scale per guest is one broker call per user per market per day, which is the
-- user's own Zerodha quota, not ours.
--
-- ADVISORY-ONLY and READ-ONLY. It touches no order path — the guest client has
-- no order method to call — and writes only `user_*` tables, never a table the
-- owner's live pages, kill-switch NAV baseline, Guardian or paper book read.
--
-- With no guest connected this is a single indexed SELECT returning zero rows,
-- so scheduling it before anyone connects costs nothing and avoids a second
-- deployment step at the moment someone does.

do $$
declare j text;
begin
  foreach j in array array['kairos-user-holding-risk-us','kairos-user-holding-risk-india']
  loop
    begin
      perform cron.unschedule(j);
    exception when others then null;
    end;
  end loop;
end $$;

select cron.schedule('kairos-user-holding-risk-india', '15 11 * * 1-5',
  $$select kairos_call_agent('/api/agents/user-holding-risk?market=india', '{}'::jsonb, 'POST', 290000)$$);

select cron.schedule('kairos-user-holding-risk-us', '45 21 * * 1-5',
  $$select kairos_call_agent('/api/agents/user-holding-risk?market=us', '{}'::jsonb, 'POST', 290000)$$);
