-- Weekend cache-warming: run prewarm + evidence-shadow 7 days/week so the idle,
-- daily-reset provider quota (AV 25/day etc.) isn't wasted Sat/Sun and the
-- research backlog keeps draining over the weekend. Trading agents stay
-- weekday-only (markets closed). The routes themselves self-skip on a weekend
-- when the per-market research_queue backlog is shallow (<10), so a quiet weekend
-- makes no pointless calls. Warm-only — no scoring, no order path.
select cron.alter_job((select jobid from cron.job where jobname='kairos-prewarm-us'),           schedule => '2,7,12,17,22,27,32,37,42,47,52,57 12 * * *');
select cron.alter_job((select jobid from cron.job where jobname='kairos-prewarm-india'),        schedule => '2,12,22,32,42,52 3 * * *');
select cron.alter_job((select jobid from cron.job where jobname='kairos-evidence-shadow-us'),   schedule => '20,35,50 14 * * *');
select cron.alter_job((select jobid from cron.job where jobname='kairos-evidence-shadow-india'),schedule => '30,40,50 4 * * *');
