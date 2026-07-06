-- Portfolio Constructor: human-set, agent-immutable cross-position risk limits
-- (same moral-hazard rule as the sector cap in 056 — the agents size trades
-- against these, they never change them). All nullable so the app's own
-- DEFAULT_LIMITS (lib/portfolio/constructor.ts) apply until a human sets these.

alter table strategy_config add column if not exists max_gross_exposure_pct numeric;
alter table strategy_config add column if not exists max_sector_exposure_pct numeric;
alter table strategy_config add column if not exists max_name_exposure_pct numeric;
alter table strategy_config add column if not exists max_portfolio_vol_pct numeric;
alter table strategy_config add column if not exists max_avg_pairwise_corr numeric;
