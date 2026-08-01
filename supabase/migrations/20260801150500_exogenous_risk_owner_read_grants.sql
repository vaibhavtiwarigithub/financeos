-- RLS policies filter rows but do not grant table privileges. Restore only the
-- owner-read surface intended by the P0 schema; authenticated users still pass
-- the owner-email policy and retain no write privilege.
grant select on public.exogenous_observations, public.market_regime_runs to authenticated;
