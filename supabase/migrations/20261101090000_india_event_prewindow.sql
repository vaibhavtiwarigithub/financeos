-- Move one existing India news/event pair before the market session so
-- overnight/weekend items can be present for the first research observation.
-- Reuse the existing job names and endpoints; total cron count is unchanged.

do $$ begin
  perform cron.unschedule('kairos-india-news-shadow-2');
exception when others then null;
end $$;

do $$ begin
  perform cron.unschedule('kairos-llm-events-2');
exception when others then null;
end $$;

select cron.schedule(
  'kairos-india-news-shadow-2',
  '45 2 * * *',
  $$select public.kairos_call_agent('/api/agents/india-news-shadow', '{}'::jsonb, 'POST', 60000)$$
);

select cron.schedule(
  'kairos-llm-events-2',
  '10 3 * * *',
  $$select public.kairos_call_agent('/api/agents/llm-events', '{}'::jsonb, 'POST', 120000)$$
);
