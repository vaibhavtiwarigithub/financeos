-- Weekend cache-warming: run prewarm + evidence-shadow 7 days/week so the idle,
-- daily-reset provider quota (AV 25/day etc.) isn't wasted Sat/Sun and the
-- research backlog keeps draining over the weekend. Trading agents stay
-- weekday-only (markets closed). The routes themselves self-skip on a weekend
-- when the per-market research_queue backlog is shallow (<10), so a quiet weekend
-- makes no pointless calls. Warm-only — no scoring, no order path.
do $$
declare
  v_jobid bigint;
  v_name text;
  v_schedule text;
begin
  for v_name, v_schedule in
    select * from (values
      ('kairos-prewarm-us', '2,7,12,17,22,27,32,37,42,47,52,57 12 * * *'),
      ('kairos-prewarm-india', '2,12,22,32,42,52 3 * * *'),
      ('kairos-evidence-shadow-us', '20,35,50 14 * * *'),
      ('kairos-evidence-shadow-india', '30,40,50 4 * * *')
    ) as schedules(jobname, schedule)
  loop
    select jobid into v_jobid from cron.job where jobname = v_name;
    if v_jobid is not null then
      perform cron.alter_job(v_jobid, schedule => v_schedule);
    end if;
  end loop;
end $$;
