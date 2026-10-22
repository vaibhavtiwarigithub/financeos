-- Reuse the bounded India retry AFTER the 11:15 UTC EOD NAV producer.
-- The 10:15 initial still captures benchmark prices shortly after NSE close.
do $$
declare
  retry record;
begin
  select jobid, schedule, command into strict retry from cron.job
    where jobname = 'kairos-benchmark-scorecard-india-retry';
  if retry.schedule not in ('45 10 * * 1-5', '35 11 * * 1-5')
    or position('/api/agents/benchmark-scorecard?market=india&attempt=retry&local_slot=' in retry.command) = 0
    or (position('local_slot=16:15' in retry.command) = 0
      and position('local_slot=17:05' in retry.command) = 0) then
    raise exception 'India benchmark retry drift: inspect before rescheduling';
  end if;
  perform cron.alter_job(retry.jobid, schedule := '35 11 * * 1-5',
    command := replace(retry.command, 'local_slot=16:15', 'local_slot=17:05'));
end $$;
