-- Daily Per-Holding Risk Analytics — pg_cron schedule.
-- Spec: features/holding-risk-daily/FEATURE_ARCHITECTURE.md ("Cron").
--
-- Fires POST /api/agents/holding-risk?market=<market> once per weekday, AFTER the
-- respective exchange close AND after the authoritative account-snapshot refresh, so
-- the run scores a settled, coherent post-close book. The route itself fails closed
-- (publishes a failed/insufficient-data run, never yesterday-as-today) when the
-- broker snapshot is missing/stale, so timing is a best-effort ordering, not a
-- correctness dependency. This cron is ADVISORY-ONLY: it computes risk scores and
-- posture and touches NO order path — it cannot place, cancel, or modify any order.
--
-- Timing (UTC, EDT summer — shift the US job 1h at the Nov EST changeover):
--   US:    close 16:00 ET (20:00 UTC). `kairos-nav-snapshot` refreshes the account
--          book at 21:00 UTC. This fires 21:30 UTC (17:30 ET) — after BOTH close and
--          the snapshot refresh.
--   India: close 15:30 IST (10:00 UTC). This fires 11:00 UTC (16:30 IST) — after close.
-- 290s timeout: route maxDuration is 300s (fans out per-account fetch + per-holding
-- candles + a batched best-effort LLM note pass).

-- Idempotent re-schedule: drop any prior job of the same name first.
do $$
declare j text;
begin
  foreach j in array array['kairos-holding-risk-us','kairos-holding-risk-india']
  loop
    begin
      perform cron.unschedule(j);
    exception when others then null;
    end;
  end loop;
end $$;

select cron.schedule('kairos-holding-risk-us', '30 21 * * 1-5',
  $$select kairos_call_agent('/api/agents/holding-risk?market=us', '{}'::jsonb, 'POST', 290000)$$);

select cron.schedule('kairos-holding-risk-india', '0 11 * * 1-5',
  $$select kairos_call_agent('/api/agents/holding-risk?market=india', '{}'::jsonb, 'POST', 290000)$$);
