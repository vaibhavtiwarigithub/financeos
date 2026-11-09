-- Reduce duplicate council schedule rows without changing cadence or work.
-- The three same-market jobs share one endpoint command and disjoint UTC hour
-- windows; one cron expression can represent their exact union.
-- Rollback: restore the original three schedules per market from
-- 20261013030000_llm_council_slot_schedule.sql and
-- 20261012210000_llm_council_drain_schedule.sql.
DO $$
DECLARE
  market_name text;
  merged_window text;
  expected_command text;
  slot record;
  matching_rows integer;
  survivor_jobid bigint;
  duplicate record;
BEGIN
  FOREACH market_name IN ARRAY ARRAY['india', 'us'] LOOP
    IF market_name = 'india' THEN
      merged_window := '*/15 4-5,7-8,11-12 * * 1-5';
    ELSE
      merged_window := '*/15 13-16,18-20,22-23 * * 1-5';
    END IF;

    expected_command := format(
      'select public.kairos_call_agent(%L, ''{}''::jsonb, ''POST'', 290000)',
      '/api/agents/llm-council/cron?market=' || market_name
    );

    FOR slot IN
      SELECT * FROM (VALUES
        ('kairos-council-' || market_name,
          CASE WHEN market_name = 'india' THEN '*/15 11-12 * * 1-5' ELSE '*/15 22-23 * * 1-5' END),
        ('kairos-council-' || market_name || '-am',
          CASE WHEN market_name = 'india' THEN '*/15 4-5 * * 1-5' ELSE '*/15 13-16 * * 1-5' END),
        (CASE WHEN market_name = 'india' THEN 'kairos-council-india-mid' ELSE 'kairos-council-us-pm' END,
          CASE WHEN market_name = 'india' THEN '*/15 7-8 * * 1-5' ELSE '*/15 18-20 * * 1-5' END)
      ) AS expected(jobname, schedule)
    LOOP
      SELECT count(*) INTO matching_rows FROM cron.job
       WHERE jobname = slot.jobname AND active
         AND schedule = slot.schedule AND command = expected_command;
      IF matching_rows <> 1 THEN
        RAISE EXCEPTION 'Unexpected council schedule %, market %; refusing consolidation', slot.jobname, market_name;
      END IF;
    END LOOP;

    SELECT jobid INTO STRICT survivor_jobid
      FROM cron.job WHERE jobname = 'kairos-council-' || market_name;
    PERFORM cron.alter_job(survivor_jobid, schedule := merged_window);

    FOR duplicate IN
      SELECT jobid FROM cron.job
       WHERE jobname = ANY(CASE WHEN market_name = 'us'
         THEN ARRAY['kairos-council-us-am','kairos-council-us-pm']
         ELSE ARRAY['kairos-council-india-am','kairos-council-india-mid'] END)
    LOOP
      PERFORM cron.unschedule(duplicate.jobid);
    END LOOP;
  END LOOP;
END $$;
