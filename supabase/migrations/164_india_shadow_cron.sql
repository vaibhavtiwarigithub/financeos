-- Migration 164: pg_cron schedules for India and US autonomous shadow runs.
-- Replaces the removed Vercel cron entry (autonomous-shadow was the 3rd of 5 Hobby slots).
-- US shadow: 13:30 UTC Mon–Fri (30 min after US open 13:30 UTC / 9:30 ET).
-- India shadow: 07:30 UTC Mon–Fri (just before India market open 09:15 IST = 03:45 UTC;
--   07:30 UTC = 13:00 IST gives mid-session signals after morning research run at ~06:45 UTC).
-- Both use kairos_call_agent (Vault-backed) — no credential in SQL.

SELECT cron.schedule(
  'kairos-shadow-us',
  '30 13 * * 1-5',
  $$SELECT kairos_call_agent('/api/agents/autonomous-shadow/cron?market=us', '{}', 'POST', 115000)$$
);

SELECT cron.schedule(
  'kairos-shadow-india',
  '30 7 * * 1-5',
  $$SELECT kairos_call_agent('/api/agents/autonomous-shadow/cron?market=india', '{}', 'POST', 115000)$$
);
