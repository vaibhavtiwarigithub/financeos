-- Append-only means UPDATE, DELETE and TRUNCATE are independently blocked.
-- A row trigger does not fire for TRUNCATE, so add a statement trigger and
-- remove destructive privileges from the server role as a second barrier.

drop trigger if exists instrument_family_observations_no_truncate
  on public.instrument_family_observations;
create trigger instrument_family_observations_no_truncate
  before truncate on public.instrument_family_observations
  for each statement execute function public.instrument_family_observations_immutable();

revoke update, delete, truncate on public.instrument_family_observations
  from anon, authenticated, service_role;
