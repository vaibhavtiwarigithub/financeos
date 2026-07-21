-- One deterministic paper-entry attempt per market session.
-- The old research tail-call duplicated these jobs, filled US before the open,
-- and left the India fallback until after the close. The route now also owns a
-- hard regular-session guard.

do $$
declare j text;
begin
  foreach j in array array['kairos-paper-trade-us', 'kairos-paper-trade-india']
  loop
    begin
      perform cron.unschedule(j);
    exception when others then null;
    end;
  end loop;
end $$;

-- 15:15 UTC = 11:15 EDT / 10:15 EST, safely after the 09:30 ET open.
select cron.schedule(
  'kairos-paper-trade-us',
  '15 15 * * 1-5',
  $$select public.kairos_call_agent('/api/agents/paper-trade?market=us', '{}'::jsonb, 'POST', 120000)$$
);

-- 04:10 UTC = 09:40 IST, after research starts and inside NSE hours.
select cron.schedule(
  'kairos-paper-trade-india',
  '10 4 * * 1-5',
  $$select public.kairos_call_agent('/api/agents/paper-trade?market=india', '{}'::jsonb, 'POST', 120000)$$
);
