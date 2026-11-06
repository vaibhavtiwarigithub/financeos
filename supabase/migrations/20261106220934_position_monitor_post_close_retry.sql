-- Second post-close paper mark run. The 16:15 ET run can reach the vendor before it has published the just-closed session; the session guard
-- (quoteIsFromSession) then rejects the previous-session quote instead of marking it as fresh, and this run re-reads at 16:45 ET.
-- Both UTC hours are scheduled and the local_slot guard admits exactly one, so DST needs no schedule change.
select cron.schedule('kairos-position-monitor-retry', '45 20,21 * * 1-5',
  $$select public.kairos_call_agent('/api/agents/position-monitor?market=us&local_slot=16%3A45', '{}'::jsonb, 'POST', 120000)$$);
