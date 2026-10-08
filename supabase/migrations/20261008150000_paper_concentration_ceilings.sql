-- Owner-approved paper-only ceilings. Shared 30%/12% fields remain the live
-- gate's limits; PaperTrader alone reads these additive columns.
alter table public.strategy_config
  add column if not exists max_sector_exposure_pct_paper numeric not null default 60,
  add column if not exists max_name_exposure_pct_paper numeric not null default 20;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.strategy_config'::regclass
      and conname = 'strategy_config_paper_sector_exposure_pct_range'
  ) then
    alter table public.strategy_config
      add constraint strategy_config_paper_sector_exposure_pct_range
      check (max_sector_exposure_pct_paper >= 0 and max_sector_exposure_pct_paper <= 100);
  end if;
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.strategy_config'::regclass
      and conname = 'strategy_config_paper_name_exposure_pct_range'
  ) then
    alter table public.strategy_config
      add constraint strategy_config_paper_name_exposure_pct_range
      check (max_name_exposure_pct_paper >= 0 and max_name_exposure_pct_paper <= 100);
  end if;
end
$$;
