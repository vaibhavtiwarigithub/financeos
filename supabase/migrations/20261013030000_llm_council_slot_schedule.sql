-- Council shadows every decision slot (owner request 2026-10-13). It scores each NEW research observation soon after the
-- research run that produced it, so every paper-trade slot has a matching shadow forecast; later windows are catch-up only.
-- All times UTC, Mon-Fri. US windows cover both DST offsets (research is 09:00 ET and 14:00 ET); a window with nothing new returns at once.
--   India  research 04:00 (+05:00 discovery) -> trader 04:10      council 04:05-05:55
--          research 07:00                    -> trader 07:45      council 07:05-08:55
--          catch-up                                               council 11:00-12:55   (existing)
--   US     research 09:00 ET = 13:00/14:00   -> trader 11:15 ET   council 13:05-16:55
--          research 14:00 ET = 18:00/19:00   -> trader 15:15 ET   council 18:05-20:55
--          catch-up                                               council 22:00-23:55   (existing)
select cron.schedule('kairos-council-india-am', '*/5 4-5 * * 1-5', $$select public.kairos_call_agent('/api/agents/llm-council/cron?market=india', '{}'::jsonb, 'POST', 290000)$$);
select cron.schedule('kairos-council-india-mid', '*/5 7-8 * * 1-5', $$select public.kairos_call_agent('/api/agents/llm-council/cron?market=india', '{}'::jsonb, 'POST', 290000)$$);
select cron.schedule('kairos-council-us-am', '*/5 13-16 * * 1-5', $$select public.kairos_call_agent('/api/agents/llm-council/cron?market=us', '{}'::jsonb, 'POST', 290000)$$);
select cron.schedule('kairos-council-us-pm', '*/5 18-20 * * 1-5', $$select public.kairos_call_agent('/api/agents/llm-council/cron?market=us', '{}'::jsonb, 'POST', 290000)$$);
