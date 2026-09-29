-- Keep the cash-deployment preference isolated to paper trading. The shared
-- max_gross_exposure_pct is also consumed by live risk checks and stays intact.
-- 100% is a no-leverage ceiling, not a buy target; all other entry gates remain.
alter table public.strategy_config
  add column if not exists max_gross_exposure_pct_paper numeric not null default 100;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conrelid = 'public.strategy_config'::regclass
      and conname = 'strategy_config_paper_gross_exposure_pct_range'
  ) then
    alter table public.strategy_config
      add constraint strategy_config_paper_gross_exposure_pct_range
      check (max_gross_exposure_pct_paper >= 0 and max_gross_exposure_pct_paper <= 100);
  end if;
end
$$;
