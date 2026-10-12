-- The council now scores every research symbol once per session. A run handles ~30 symbols (bounded pool + 200 s guard),
-- so it is invoked every 5 minutes inside each market's scoring window until nothing is left (it then returns at once).
-- India research finishes ~07:00 UTC, US ~18:00 UTC; windows leave slack for retries. vercel.json council crons were removed
-- (hour precision, one symbol per call) so there is a single scheduler.
select cron.schedule('kairos-council-india', '*/5 11-12 * * 1-5', $$select public.kairos_call_agent('/api/agents/llm-council/cron?market=india', '{}'::jsonb, 'POST', 290000)$$);
select cron.schedule('kairos-council-us', '*/5 22-23 * * 1-5', $$select public.kairos_call_agent('/api/agents/llm-council/cron?market=us', '{}'::jsonb, 'POST', 290000)$$);
