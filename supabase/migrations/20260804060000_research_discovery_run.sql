-- Discovery-only research run, on its own budget.
--
-- gatherSymbols orders candidates holdings -> manual watchlist -> carry-forward
-- -> watchlist -> screener, and the wall-clock budget cuts from the tail. With
-- 54 US holdings and 16 watchlist names against a ~100-symbol batch that already
-- deferred ~51, screener candidates sat permanently at the back and were NEVER
-- scored: zero screener-sourced decisions across all of 2026-07, regardless of
-- whether discovery itself worked. Discovery and exit re-scoring competed for
-- one budget, and exits rightly win, so the funnel could never contribute
-- evidence to the ledger.
--
-- `scope=discovery` takes only the never-held discovery buckets. Holdings are
-- excluded outright, so this run cannot touch an exit/SELL path.
--
-- Scheduled AFTER each market's main research run so it works on a warm cache
-- and never competes with exit re-scoring:
--   US    14:30 UTC (main run 13:00)
--   India 05:00 UTC (main run 04:00)
-- Idempotent.

do $$
begin
  perform cron.unschedule('kairos-research-discovery-us');
exception when others then null;
end $$;

do $$
begin
  perform cron.unschedule('kairos-research-discovery-india');
exception when others then null;
end $$;

select cron.schedule('kairos-research-discovery-us', '30 14 * * 1-5',
  $$select kairos_call_agent('/api/agents/research/cron?market=us&scope=discovery')$$);

select cron.schedule('kairos-research-discovery-india', '0 5 * * 1-5',
  $$select kairos_call_agent('/api/agents/research/cron?market=india&scope=discovery')$$);
