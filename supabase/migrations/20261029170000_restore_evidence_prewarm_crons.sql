-- Restore the evidence-prewarm schedules into the tracked migration chain.
-- The original job creation was applied out of band; earlier migrations only
-- altered those rows, which made clean database replay fail. Existing production
-- jobs are preserved unchanged; only absent jobs are created.
do $migration$
begin
  if not exists (select 1 from cron.job where jobname = 'kairos-prewarm-us') then
    perform cron.schedule(
      'kairos-prewarm-us',
      '2,7,12,17,22,27,32,37,42,47,52,57 12 * * *',
      $command$select public.kairos_call_agent('/api/agents/prewarm?market=us', '{}'::jsonb, 'POST', 55000)$command$
    );
  end if;

  if not exists (select 1 from cron.job where jobname = 'kairos-prewarm-india') then
    perform cron.schedule(
      'kairos-prewarm-india',
      '2,12,22,32,42,52 3 * * *',
      $command$select public.kairos_call_agent('/api/agents/prewarm?market=india', '{}'::jsonb, 'POST', 55000)$command$
    );
  end if;
end $migration$;
