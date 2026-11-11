-- Preserve the staggered v3 jobs and skip HTTP dispatch outside the regular NY window.
-- Routes still enforce the exchange calendar, including holidays and early closes.
DO $$
DECLARE
  symbols constant text[] := ARRAY['soxl', 'tqqq', 'sqqq', 'soxs'];
  session_filter constant text := $filter$
where (statement_timestamp() at time zone 'America/New_York')::time >= time '09:30'
  and (statement_timestamp() at time zone 'America/New_York')::time < time '16:00'$filter$;
  symbol text;
  minute_offset integer;
  job_name text;
  expected_minutes text;
  original_command text;
  guarded_command text;
  existing_job cron.job%ROWTYPE;
BEGIN
  FOREACH symbol IN ARRAY symbols LOOP
    job_name := 'kairos-' || symbol || '-intraday-v3';
    minute_offset := array_position(symbols, symbol) - 1;
    SELECT string_agg((n * 5 + minute_offset)::text, ',' ORDER BY n)
      INTO expected_minutes
      FROM generate_series(0, 11) AS n;
    original_command := format(
      'select public.kairos_call_agent(%L, ''{}''::jsonb, ''POST'', 60000)',
      '/api/agents/' || symbol || '/cron'
    );
    guarded_command := original_command || session_filter;

    SELECT * INTO STRICT existing_job FROM cron.job WHERE jobname = job_name;
    IF existing_job.active IS DISTINCT FROM true
       OR existing_job.schedule IS DISTINCT FROM format('%s 13-20 * * 1-5', expected_minutes)
       OR existing_job.command IS NULL
       OR existing_job.command NOT IN (original_command, guarded_command) THEN
      RAISE EXCEPTION 'Unexpected leveraged paper schedule %, refusing dispatch change', job_name;
    END IF;

    IF existing_job.command = original_command THEN
      PERFORM cron.alter_job(existing_job.jobid, command := guarded_command);
    END IF;
  END LOOP;
END $$;
