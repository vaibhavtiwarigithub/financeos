-- SECURITY: close two RLS gaps that leaked sensitive data to the PUBLIC anon key
-- (which ships in the browser JS bundle). Both tables had full anon/authenticated
-- grants plus a permissive policy written as `qual = true` — a `qual = true`
-- policy GRANTS access to everyone, it does not restrict it. Same defect
-- migrations 042/089 already fixed for the other vault tables; these two were
-- missed.
--
-- C1: app_settings stores the vault PIN (plaintext) → anyone with the anon key
--     could read it, or overwrite it to lock the owner out.
-- C2: live_account_snapshots stores live equity / buying power / full positions
--     → any browser session could read them, bypassing requireOwner().
--
-- Non-breaking: every app read/write of these tables uses the service client
-- (verified: app/dashboard/page.tsx, app/dashboard/live-portfolio/page.tsx,
-- app/api/admin/vault/route.ts all use createServiceClient), and service_role
-- bypasses RLS + grants entirely.

revoke all on table app_settings from anon, authenticated;
drop policy if exists service_only on app_settings;

revoke all on table live_account_snapshots from anon, authenticated;
drop policy if exists service_all on live_account_snapshots;
