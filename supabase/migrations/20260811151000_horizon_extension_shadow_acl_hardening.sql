-- Remove Supabase default table privileges that would let service_role bypass
-- the row-level append-only trigger via TRUNCATE. The shadow writer needs only
-- INSERT; SELECT is retained for server-side diagnostics.

BEGIN;

REVOKE ALL ON public.horizon_extension_shadow FROM service_role;
GRANT SELECT, INSERT ON public.horizon_extension_shadow TO service_role;

COMMIT;
