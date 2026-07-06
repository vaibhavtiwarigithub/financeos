-- Kairos cloud-cron: pg_cron -> Vercel silent deployment trigger target.
-- This file is a snapshot of the FINAL live cron.job state as of 2026-07-06,
-- consolidating several incremental apply_migration calls made directly
-- against the live DB during the session (kairos_pg_cron_vercel_schedule,
-- kairos_cron_timeout_fix, plus later ad-hoc reschedules) that were never
-- captured as committed migration files until now.
--
-- Base URL: https://financeos-vaibhavtiwarigithubs-projects.vercel.app
-- Times are UTC assuming EDT (summer ET, UTC-4) — needs a 1h shift when
-- clocks change to EST in November.

create or replace function kairos_call_agent(endpoint text, body jsonb default '{}'::jsonb, method text default 'POST', timeout_ms integer default 70000)
returns void
language plpgsql
security definer
set search_path = public, vault
as $$
declare
  secret text;
  base_url text := 'https://financeos-vaibhavtiwarigithubs-projects.vercel.app';
begin
  select decrypted_secret into secret from vault.decrypted_secrets where name = 'kairos_cron_secret';
  if secret is null then
    raise exception 'kairos_cron_secret not found in vault';
  end if;

  perform net.http_post(
    url := base_url || endpoint,
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-cron-secret', secret),
    body := body,
    timeout_milliseconds := timeout_ms
  );
end;
$$;

-- Unschedule any prior versions of these jobs first (safe if they don't exist —
-- cron.unschedule errors on missing name, so wrap each in a DO block).
do $$
declare j text;
begin
  foreach j in array array[
    'kairos-brief-morning','kairos-scan-india-refresh','kairos-research-india',
    'kairos-position-monitor-india','kairos-research','kairos-trader',
    'kairos-feature-check-check','kairos-fit-calibration','kairos-rescore',
    'kairos-position-monitor','kairos-brief-evening','kairos-embed',
    'kairos-nav-snapshot','kairos-label-maturation','kairos-macro-sentinel',
    'kairos-mentor-coach','kairos-learner','kairos-proposal-reminder',
    'kairos-broker-sync','kairos-stale-check','kairos-model-check','kairos-theme-scout'
  ]
  loop
    begin
      perform cron.unschedule(j);
    exception when others then null;
    end;
  end loop;
end $$;

select cron.schedule('kairos-brief-morning', '0 14 * * 1-5',
  $$select kairos_call_agent('/api/briefing/generate', '{"session":"morning"}'::jsonb)$$);

select cron.schedule('kairos-scan-india-refresh', '45 10 * * 1-5',
  $$select kairos_call_agent('/api/scan/india/refresh', '{}'::jsonb, 'POST', 310000)$$);

select cron.schedule('kairos-research-india', '0 11 * * 1-5',
  $$select kairos_call_agent('/api/agents/research/cron?market=india')$$);

select cron.schedule('kairos-position-monitor-india', '15 11 * * 1-5',
  $$select kairos_call_agent('/api/agents/position-monitor?market=india')$$);

-- 160s timeout: Theme Scout now runs awaited BEFORE gatherSymbols inside this
-- same route (Decision: same-day theme discoveries), so this job's own
-- budget must cover both.
select cron.schedule('kairos-research', '0 13 * * 1-5',
  $$select kairos_call_agent('/api/agents/research/cron?market=us', '{}'::jsonb, 'POST', 160000)$$);

select cron.schedule('kairos-trader', '45 13 * * 1-5',
  $$select kairos_call_agent('/api/agents/trader')$$);

-- kairos-theme-scout intentionally NOT re-scheduled standalone — research/cron
-- now calls it inline (US-scoped only), so a separate cron job would double-fire it.

select cron.schedule('kairos-feature-check-check', '30 20 * * 5',
  $$select kairos_call_agent('/api/validation/feature-check')$$);

select cron.schedule('kairos-fit-calibration', '45 20 * * 5',
  $$select kairos_call_agent('/api/validation/fit-calibration')$$);

select cron.schedule('kairos-rescore', '45 20 * * 1-5',
  $$select kairos_call_agent('/api/agents/rescore-check')$$);

select cron.schedule('kairos-position-monitor', '15 20 * * 1-5',
  $$select kairos_call_agent('/api/agents/position-monitor?market=us')$$);

select cron.schedule('kairos-brief-evening', '30 20 * * 1-5',
  $$select kairos_call_agent('/api/briefing/generate', '{"session":"evening"}'::jsonb)$$);

select cron.schedule('kairos-embed', '50 20 * * 1-5',
  $$select kairos_call_agent('/api/live-portfolio/embed', '{"limit":200}'::jsonb, 'POST', 310000)$$);

select cron.schedule('kairos-nav-snapshot', '0 21 * * 1-5',
  $$select kairos_call_agent('/api/agents/performance', '{"action":"snapshot"}'::jsonb)$$);

select cron.schedule('kairos-label-maturation', '0 22 * * 1-5',
  $$select kairos_call_agent('/api/agents/label-maturation', '{}'::jsonb, 'POST', 310000)$$);

-- NOTE: schedule reads Monday ('30 12 * * 1'), NOT weekly-across-weekdays —
-- lib/schedule.ts's display metadata for this job had a days/time mismatch
-- (fixed separately in the same change as this migration).
select cron.schedule('kairos-macro-sentinel', '30 12 * * 1',
  $$select kairos_call_agent('/api/agents/macro-sentinel')$$);

select cron.schedule('kairos-mentor-coach', '15 21 * * 5',
  $$select kairos_call_agent('/api/agents/mentor-coach')$$);

select cron.schedule('kairos-learner', '0 21 * * 5',
  $$select kairos_call_agent('/api/agents/learner')$$);

select cron.schedule('kairos-proposal-reminder', '*/15 13-20 * * 1-5',
  $$select kairos_call_agent('/api/alerts/proposal-reminder')$$);

select cron.schedule('kairos-broker-sync', '0,30 13-20 * * 1-5',
  $$select kairos_call_agent('/api/broker/orders/sync')$$);

select cron.schedule('kairos-stale-check', '0 */4 * * *',
  $$select net.http_get(url := 'https://financeos-vaibhavtiwarigithubs-projects.vercel.app/api/alerts/stale-check', timeout_milliseconds := 30000)$$);

-- Runs Monday 7:30 AM ET (11:30 UTC) — see lib/schedule.ts's corresponding
-- fixed display entry (days should read Monday-consistent, not "Friday").
select cron.schedule('kairos-model-check', '30 11 * * 1',
  $$select kairos_call_agent('/api/models/check')$$);
