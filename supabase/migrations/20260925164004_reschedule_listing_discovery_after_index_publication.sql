-- Remote version 20260925164004; applied through Supabase MCP.
-- SEC builds a daily index after 22:00 ET, potentially taking several hours.
-- 08:35 UTC is after 03:00 ET year-round. Tuesday-Saturday consumes Mon-Fri.
-- The bounded retry dispatches only if today's primary did not complete.
begin;
do $$
declare existing_job bigint;
begin
  select jobid into existing_job from cron.job where jobname='kairos-listing-discovery-us';
  if existing_job is null then raise exception 'listing discovery primary job missing'; end if;
  perform cron.alter_job(existing_job, schedule := '35 8 * * 2-6');
end;
$$;
select cron.schedule('kairos-listing-discovery-us-retry', '35 11 * * 2-6', $job$
  select public.kairos_call_agent('/api/agents/listing-discovery?market=us', '{}'::jsonb, 'POST', 60000)
  where not exists (
    select 1 from public.agent_runs
    where agent_type='listing_discovery' and market='us' and status='completed'
      and started_at >= date_trunc('day', now() at time zone 'UTC') at time zone 'UTC'
  )
$job$);
commit;
