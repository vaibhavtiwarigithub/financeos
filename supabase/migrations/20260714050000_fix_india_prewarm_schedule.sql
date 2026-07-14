-- Fix: India evidence prewarm was scheduled in the 09:00 UTC hour, but India
-- research runs at 04:00 UTC — so prewarm fired 5 HOURS AFTER research and the
-- India run always cold-started. GDELT sentiment (1 req/5s) got paced out on the
-- cold run, producing recurring `data-availability:india:sentiment 0/8` alerts.
-- Move India prewarm to the 03:00 hour so it warms the evidence cache BEFORE the
-- 04:00 research run (mirrors US: prewarm hour 12 → research 13:00). Data-fetch
-- warming only — no scoring, no order path.
select cron.alter_job(
  (select jobid from cron.job where jobname = 'kairos-prewarm-india'),
  schedule => '2,12,22,32,42,52 3 * * 1-5'
);
