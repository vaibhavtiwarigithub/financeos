-- Run after the US paper-trader window and outside the 14:00-15:15 provider
-- cluster. This also lets the holdings shadow observe positions opened today.

select cron.unschedule(jobid)
from cron.job
where jobname = 'kairos-earnings-risk-monitor-us';

select cron.schedule(
  'kairos-earnings-risk-monitor-us',
  '0 16 * * 1-5',
  $$select kairos_call_agent('/api/agents/earnings-risk-monitor', '{}'::jsonb, 'POST', 310000)$$
);
