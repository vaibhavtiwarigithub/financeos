-- Agent Mind Phase 3: generate the macro-to-holdings read once each weekday
-- morning (cheap cached LLM call, idempotent per day). US after the US research
-- window, India after the India window.
select cron.schedule('kairos-macro-read-us', '30 13 * * 1-5',
  $$select kairos_call_agent('/api/agent-mind/macro-read?market=us')$$);
select cron.schedule('kairos-macro-read-india', '30 4 * * 1-5',
  $$select kairos_call_agent('/api/agent-mind/macro-read?market=india')$$);
