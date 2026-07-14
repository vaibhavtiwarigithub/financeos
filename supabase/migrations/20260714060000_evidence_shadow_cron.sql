-- Canonical Evidence Router — dual-run shadow crons (observational only).
--
-- Run the evidence-shadow tick a few times after each market's research run so
-- the resolver resolves the day's universe and accumulates coverage/disagreement
-- evidence in provider_call_ledger + evidence_cache_v2. router_enabled stays
-- false — this NEVER feeds scoring or the money path. Bounded (45s) + resumable
-- (fresh cache short-circuits), so 3 ticks/day drain the universe over the run.
--
-- US research fires 13:00 UTC → shadow in the 14:00 hour (after research+trader).
-- India research fires 04:00 UTC → shadow later in the 04:00 hour.
select cron.schedule(
  'kairos-evidence-shadow-us',
  '20,35,50 14 * * 1-5',
  $$select public.kairos_call_agent('/api/agents/evidence-shadow?market=us', '{}'::jsonb, 'POST', 55000)$$
);
select cron.schedule(
  'kairos-evidence-shadow-india',
  '30,40,50 4 * * 1-5',
  $$select public.kairos_call_agent('/api/agents/evidence-shadow?market=india', '{}'::jsonb, 'POST', 55000)$$
);
