-- Theme Scout is discovery-only and must not consume ResearchAgent's wall-clock
-- or provider budget. Run it weekly at Sunday 20:00 ET (Monday 00:00 UTC during
-- daylight time), leaving ample time for its validated watchlist additions to
-- enter Monday's US research queue.
do $$
begin
  perform cron.unschedule('kairos-theme-scout');
exception when others then null;
end $$;

select cron.schedule(
  'kairos-theme-scout',
  '0 0 * * 1',
  $$select kairos_call_agent('/api/agents/theme-scout', '{}'::jsonb, 'POST', 70000)$$
);
