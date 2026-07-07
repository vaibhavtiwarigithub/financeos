-- api_key_vault: policy said "service_only" but applied USING(true) to ALL
-- roles, and anon/authenticated still held INSERT/UPDATE/DELETE grants —
-- anyone with the public anon key could overwrite or delete broker tokens.
-- All app access goes through the service-role client (bypasses RLS), so
-- revoking client roles entirely is non-breaking.
drop policy if exists "service_only" on api_key_vault;
revoke all on table api_key_vault from anon, authenticated;

-- broker_orders: RLS was disabled with full grants to client roles — anon
-- could read and rewrite live order rows. Reads for the dashboard go through
-- API routes (service client), so client roles need nothing.
alter table broker_orders enable row level security;
revoke all on table broker_orders from anon, authenticated;
