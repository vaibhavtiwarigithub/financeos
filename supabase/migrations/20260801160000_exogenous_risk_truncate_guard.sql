-- Close the append-only hole in 20260801150000.
--
-- That migration defends append-only with a BEFORE ROW UPDATE OR DELETE trigger
-- only. A row-level trigger DOES NOT FIRE ON TRUNCATE, and service_role was left
-- holding the TRUNCATE grant, so the whole evidence ledger could be erased while
-- every stated guarantee still appeared to be in place. Verified in production:
--   exogenous_observations_no_mutation -> BEFORE ROW DELETE UPDATE (no TRUNCATE)
--   market_regime_runs_no_mutation     -> BEFORE ROW DELETE UPDATE (no TRUNCATE)
--
-- Two independent defences, matching the earnings_risk_observations pattern
-- where revoked grants and a trigger both hold:
--   1. statement-level TRUNCATE triggers, and
--   2. revoke UPDATE/DELETE/TRUNCATE from service_role, which only ever INSERTs.
--
-- Idempotent. No table, column, policy or RLS change.

create or replace function public.exogenous_risk_no_truncate()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception 'exogenous-risk evidence is append-only: TRUNCATE is not permitted';
end;
$$;

revoke all on function public.exogenous_risk_no_truncate() from public, anon, authenticated;

drop trigger if exists exogenous_observations_no_truncate on public.exogenous_observations;
create trigger exogenous_observations_no_truncate
  before truncate on public.exogenous_observations
  for each statement execute function public.exogenous_risk_no_truncate();

drop trigger if exists market_regime_runs_no_truncate on public.market_regime_runs;
create trigger market_regime_runs_no_truncate
  before truncate on public.market_regime_runs
  for each statement execute function public.exogenous_risk_no_truncate();

-- The writer only ever INSERTs. Removing these leaves the trigger as a second
-- barrier rather than the only one.
revoke update, delete, truncate on public.exogenous_observations from service_role;
revoke update, delete, truncate on public.market_regime_runs from service_role;

comment on function public.exogenous_risk_no_truncate() is
  'Statement-level TRUNCATE guard. Row triggers do not fire on TRUNCATE, so append-only needs this separately.';
