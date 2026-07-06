-- agent_runs.market — lets Agent Calendar/History filter by market. Only
-- research/cron writes this so far (trader/paper-trade/position-monitor
-- still don't tag their own rows — a known, not-yet-fixed gap).
alter table agent_runs add column if not exists market text;

-- Backfill from symbols where inferable (India symbols end .NS/.BO)
update agent_runs set market = 'india'
where market is null and symbols is not null
  and exists (select 1 from jsonb_array_elements_text(to_jsonb(symbols)) s where s ~* '\.(NS|BO)$');
update agent_runs set market = 'us' where market is null;
