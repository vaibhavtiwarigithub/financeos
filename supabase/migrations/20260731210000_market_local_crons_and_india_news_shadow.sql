-- Keep US agent slots fixed in America/New_York across EDT/EST.
-- Each job fires at both possible UTC hours; the route-local slot guard admits
-- exactly one and exits the seasonal duplicate before provider/DB work.

do $$
declare j text;
begin
  foreach j in array array[
    'kairos-research',
    'kairos-paper-trade-us',
    'kairos-research-us-pm',
    'kairos-paper-trade-us-pm',
    'kairos-position-monitor',
    'kairos-india-news-shadow'
  ] loop
    begin
      perform cron.unschedule(j);
    exception when others then null;
    end;
  end loop;
end $$;

select cron.schedule(
  'kairos-research',
  '0 13,14 * * 1-5',
  $$select public.kairos_call_agent('/api/agents/research/cron?market=us&local_slot=09%3A00', '{}'::jsonb, 'POST', 160000)$$
);

select cron.schedule(
  'kairos-paper-trade-us',
  '15 15,16 * * 1-5',
  $$select public.kairos_call_agent('/api/agents/paper-trade?market=us&local_slot=11%3A15', '{}'::jsonb, 'POST', 120000)$$
);

select cron.schedule(
  'kairos-research-us-pm',
  '0 18,19 * * 1-5',
  $$select public.kairos_call_agent('/api/agents/research/cron?market=us&local_slot=14%3A00', '{}'::jsonb, 'POST', 160000)$$
);

select cron.schedule(
  'kairos-paper-trade-us-pm',
  '15 19,20 * * 1-5',
  $$select public.kairos_call_agent('/api/agents/paper-trade?market=us&local_slot=15%3A15', '{}'::jsonb, 'POST', 120000)$$
);

select cron.schedule(
  'kairos-position-monitor',
  '15 20,21 * * 1-5',
  $$select public.kairos_call_agent('/api/agents/position-monitor?market=us&local_slot=16%3A15', '{}'::jsonb, 'POST', 120000)$$
);

-- Daily, including weekends/holidays: news and corporate events are not limited
-- to exchange sessions. 12:15 UTC = 17:45 IST, after the regular close.
select cron.schedule(
  'kairos-india-news-shadow',
  '15 12 * * *',
  $$select public.kairos_call_agent('/api/agents/india-news-shadow', '{}'::jsonb, 'POST', 60000)$$
);
