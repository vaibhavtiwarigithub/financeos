-- 131 — kairos-watchdog cron (Safe-P3 janitor).
-- Every 2 hours it POSTs /api/agents/watchdog, which reaps zombie agent_runs
-- (status='running' past any function's max life), reverts orphaned 'claiming'
-- signals to pending, and expires stale pending long signals. Bounded status
-- corrections only — never touches money, positions, ledgers, or config.

do $$
begin
  begin perform cron.unschedule('kairos-watchdog'); exception when others then null; end;
end $$;

select cron.schedule('kairos-watchdog', '0 */2 * * *',
  $$select kairos_call_agent('/api/agents/watchdog', '{}'::jsonb, 'POST', 60000)$$);
