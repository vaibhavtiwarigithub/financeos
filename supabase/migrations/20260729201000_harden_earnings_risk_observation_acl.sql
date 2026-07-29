-- Repair the P0 ledger ACL for projects whose default table grants gave
-- service_role UPDATE/DELETE/TRUNCATE. The append-only trigger does not intercept
-- TRUNCATE, so least-privilege grants are part of the immutability guarantee.

revoke all on table public.earnings_risk_observations from anon, authenticated, service_role;
grant select on table public.earnings_risk_observations to authenticated;
grant select, insert on table public.earnings_risk_observations to service_role;

revoke all on sequence public.earnings_risk_observations_id_seq from anon, authenticated, service_role;
grant usage, select on sequence public.earnings_risk_observations_id_seq to service_role;
