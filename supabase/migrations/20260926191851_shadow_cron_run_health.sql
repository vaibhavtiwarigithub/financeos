-- Service-only schedule and last-run proof for shadow liveness diagnostics.
-- Applied in production as migration 20260926191851; does not change schedules
-- or any trading setting.
create or replace function public.get_shadow_cron_health()
returns table (
  jobname text,
  schedule text,
  active boolean,
  last_started_at timestamptz,
  last_status text
)
language sql
security definer
set search_path = pg_catalog, cron
as $$
  select
    j.jobname::text,
    j.schedule::text,
    j.active,
    latest.start_time,
    latest.status::text
  from cron.job as j
  left join lateral (
    select d.start_time, d.status
    from cron.job_run_details as d
    where d.jobid = j.jobid
    order by d.start_time desc
    limit 1
  ) as latest on true
  order by j.jobname;
$$;

revoke all on function public.get_shadow_cron_health() from public, anon, authenticated;
grant execute on function public.get_shadow_cron_health() to service_role;
