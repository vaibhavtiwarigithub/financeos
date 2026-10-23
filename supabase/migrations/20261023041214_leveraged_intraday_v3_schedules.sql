-- Apply ONLY AFTER the v3 runtime is production READY. Local calendar guards
-- handle DST, holidays, early closes and entry cutoff. Calls remain paper-only.
do $$
declare v_sym text; v_name text; v_min integer; v_command text; v_minutes text;
begin
  foreach v_sym in array array['soxl','tqqq','sqqq','soxs'] loop
    for v_name in select jobname from cron.job where jobname in (
      'kairos-'||v_sym||'-entry','kairos-'||v_sym||'-open',
      'kairos-'||v_sym||'-close-edt','kairos-'||v_sym||'-close-est',
      'kairos-'||v_sym||'-intraday-v3') loop
      perform cron.unschedule(v_name);
    end loop;
    v_min:=array_position(array['soxl','tqqq','sqqq','soxs'],v_sym)-1;
    select string_agg((n*5+v_min)::text,',' order by n) into v_minutes from generate_series(0,11) n;
    v_command:=format('select public.kairos_call_agent(%L, ''{}''::jsonb, ''POST'', 60000)', '/api/agents/'||v_sym||'/cron');
    perform cron.schedule('kairos-'||v_sym||'-intraday-v3',
      format('%s 13-20 * * 1-5',v_minutes),v_command);
  end loop;
end $$;

-- Move the existing four-symbol context pass BEFORE the first entry window;
-- same number of research/LLM passes, not an extra per-poll inference loop.
select cron.unschedule(jobid) from cron.job where jobname='kairos-research-leveraged-us';
select cron.schedule('kairos-research-leveraged-us','0 13,14 * * 1-5',
  $$select public.kairos_call_agent('/api/agents/research/cron?market=us&scope=leveraged&local_slot=09%3A00', '{}'::jsonb, 'POST', 160000)$$);
