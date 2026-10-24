-- Owner: keep Free and reduce workload. Match the already-deployed quarter-hour
-- admission guard. Preserve each existing command (including secret references),
-- day/hour windows, job identity and active state. No inference or trading job
-- is invoked by this migration. Rollback: replace */15 with */5 for these names.
DO $$
DECLARE job record;
BEGIN
  FOR job IN SELECT jobid, schedule FROM cron.job
    WHERE jobname IN ('kairos-council-india','kairos-council-us',
      'kairos-council-india-am','kairos-council-india-mid',
      'kairos-council-us-am','kairos-council-us-pm')
  LOOP
    IF job.schedule LIKE '*/5 %' THEN
      PERFORM cron.alter_job(job.jobid, schedule := regexp_replace(job.schedule, '^\*/5 ', '*/15 '));
    ELSIF job.schedule NOT LIKE '*/15 %' THEN
      RAISE EXCEPTION 'Unexpected council schedule; review rather than overwrite';
    END IF;
  END LOOP;
END $$;
