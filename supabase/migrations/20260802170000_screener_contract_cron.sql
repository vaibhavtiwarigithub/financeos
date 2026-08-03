-- Daily field-contract check for the Yahoo custom screener.
--
-- The screener is an undocumented endpoint whose criteria can be accepted and
-- silently discarded: no error, no exception, no failing test, just a bucket
-- that quietly widens to whatever the surviving legs allow.
-- `freecashflow.lasttwelvemonths` is already in that state, which is why it is
-- not in any shipped bucket.
--
-- 11:10 UTC daily, ahead of the US research window, so a degraded criterion is
-- reported before the day's discovery runs on it. Idempotent.

do $$
begin
  perform cron.unschedule('kairos-screener-contract');
exception when others then null;
end $$;

select cron.schedule('kairos-screener-contract', '10 11 * * 1-5',
  $$select kairos_call_agent('/api/validation/screener-contract')$$);
