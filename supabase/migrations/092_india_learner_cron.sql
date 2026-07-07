-- India learner run — mirrors the US weekly learner (Fridays) but passes
-- {"market":"india"} so India evolves its OWN champion on its own cohort. The
-- learner route now reads market from the request body and scopes its
-- idempotency guard by market, so this never collides with the US run.
-- Scheduled 20:30 UTC Fri (3:30pm ET / after India's Friday close) — still
-- Friday in ET, which the learner's weekly dow===5 guard requires.
select cron.schedule('kairos-learner-india', '30 20 * * 5',
  $$select kairos_call_agent('/api/agents/learner', '{"market":"india"}'::jsonb)$$);
