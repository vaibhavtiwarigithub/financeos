-- The unconditional time stop was removed on 2026-09-10. The old
-- next-session-sale versus extension comparator no longer matches the current
-- exit policy; exact-horizon P0 observations are written by PositionMonitor.
-- Retire only the two redundant comparator jobs. Keep the append-only history
-- for audit/reproduction and do not touch position-monitor schedules.
do $$
declare
  v_job_id bigint;
begin
  for v_job_id in
    select jobid
    from cron.job
    where jobname in (
      'kairos-horizon-extension-shadow-us',
      'kairos-horizon-extension-shadow-india'
    )
  loop
    perform cron.unschedule(v_job_id);
  end loop;
end;
$$;
