-- Shadow Registry: service-only schedule truth and removal of an idle campaign.
-- The autonomous-shadow routes remain available for a future owner-approved
-- evidence campaign; only the two zero-output recurring jobs are removed.

create or replace function public.get_shadow_cron_status()
returns table (
  jobname text,
  schedule text,
  active boolean
)
language sql
security definer
set search_path = public, cron
as $$
  select j.jobname::text, j.schedule::text, j.active
  from cron.job j
  order by j.jobname;
$$;
revoke all on function public.get_shadow_cron_status() from public, anon, authenticated;
grant execute on function public.get_shadow_cron_status() to service_role;

do $$
begin
  if exists (select 1 from cron.job where jobname = 'kairos-shadow-us') then
    perform cron.unschedule('kairos-shadow-us');
  end if;
  if exists (select 1 from cron.job where jobname = 'kairos-shadow-india') then
    perform cron.unschedule('kairos-shadow-india');
  end if;
end;
$$;
