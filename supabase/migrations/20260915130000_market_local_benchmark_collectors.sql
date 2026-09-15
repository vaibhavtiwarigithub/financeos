-- Benchmark collectors must run in the exchange's local post-close window.
--
-- `admitMarketLocalSlot()` inside the route makes the paired US UTC schedules
-- DST-safe: exactly one of the two initial calls and one of the two retry calls
-- is admitted. India has no DST, so it needs one pair. Each route invocation is
-- market-scoped and records its own agent_runs row.

do $outer$
declare
  job_name text;
begin
  if to_regprocedure('cron.schedule(text,text,text)') is not null then
    -- Replace the old one-size-fits-both 22:15 UTC collector.
    foreach job_name in array array[
      'kairos-benchmark-scorecard',
      'kairos-benchmark-scorecard-india-initial',
      'kairos-benchmark-scorecard-india-retry',
      'kairos-benchmark-scorecard-us-initial-dst',
      'kairos-benchmark-scorecard-us-initial-standard',
      'kairos-benchmark-scorecard-us-retry-dst',
      'kairos-benchmark-scorecard-us-retry-standard'
    ] loop
      begin
        perform cron.unschedule(job_name);
      exception when others then null;
      end;
    end loop;

    -- India: NSE closes 15:30 IST. Initial 15:45; bounded retry 16:15.
    perform cron.schedule(
      'kairos-benchmark-scorecard-india-initial', '15 10 * * 1-5',
      $job$select kairos_call_agent('/api/agents/benchmark-scorecard?market=india&attempt=initial&local_slot=15:45', '{}'::jsonb, 'POST', 70000)$job$
    );
    perform cron.schedule(
      'kairos-benchmark-scorecard-india-retry', '45 10 * * 1-5',
      $job$select kairos_call_agent('/api/agents/benchmark-scorecard?market=india&attempt=retry&local_slot=16:15', '{}'::jsonb, 'POST', 70000)$job$
    );

    -- US: NYSE/Nasdaq close 16:00 local. 20 UTC is EDT, 21 UTC is EST.
    -- The route rejects the non-matching local slot before any provider/DB work.
    perform cron.schedule(
      'kairos-benchmark-scorecard-us-initial-dst', '15 20 * * 1-5',
      $job$select kairos_call_agent('/api/agents/benchmark-scorecard?market=us&attempt=initial&local_slot=16:15', '{}'::jsonb, 'POST', 70000)$job$
    );
    perform cron.schedule(
      'kairos-benchmark-scorecard-us-initial-standard', '15 21 * * 1-5',
      $job$select kairos_call_agent('/api/agents/benchmark-scorecard?market=us&attempt=initial&local_slot=16:15', '{}'::jsonb, 'POST', 70000)$job$
    );
    perform cron.schedule(
      'kairos-benchmark-scorecard-us-retry-dst', '45 20 * * 1-5',
      $job$select kairos_call_agent('/api/agents/benchmark-scorecard?market=us&attempt=retry&local_slot=16:45', '{}'::jsonb, 'POST', 70000)$job$
    );
    perform cron.schedule(
      'kairos-benchmark-scorecard-us-retry-standard', '45 21 * * 1-5',
      $job$select kairos_call_agent('/api/agents/benchmark-scorecard?market=us&attempt=retry&local_slot=16:45', '{}'::jsonb, 'POST', 70000)$job$
    );
  end if;
end $outer$;
