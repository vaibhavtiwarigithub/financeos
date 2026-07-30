-- Daily, bounded US holdings earnings/options shadow.
-- It writes only behavior_changed=false observations into the existing ledger.
-- India has no options leg and is deliberately not scheduled.

select cron.unschedule(jobid)
from cron.job
where jobname = 'kairos-earnings-risk-monitor-us';

select cron.schedule(
  'kairos-earnings-risk-monitor-us',
  '0 15 * * 1-5',
  $$select kairos_call_agent('/api/agents/earnings-risk-monitor', '{}'::jsonb, 'POST', 310000)$$
);
