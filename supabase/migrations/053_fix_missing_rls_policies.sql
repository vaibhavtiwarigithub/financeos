-- Migration 053: fix 8 tables with RLS enabled but ZERO policies
--
-- Found while smoke-testing every dashboard page in browser: /dashboard/portfolio
-- rendered almost nothing. Network trace showed two client-side Supabase REST
-- calls failing (406 on strategy_config, 400 on trade_proposals). Root cause for
-- the 406 (and the same class of bug) was systemic: these 8 tables have RLS
-- enabled with NO policies at all, so PostgREST silently returns zero rows to
-- every authenticated/anon caller -- a strict "single row" query then 406s.
--
-- Found via: pg_class.relrowsecurity = true AND no matching row in pg_policies.
-- Affected: agent_memory, paper_nav_history, price_cache, risk_analytics_cache,
-- sector_breadth_history, strategy_config, trade_log, trade_queue.
--
-- Applied the same pattern used everywhere else in this app: service_role full
-- access, authenticated read-only (single-user app, no per-row ownership).

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['agent_memory','paper_nav_history','price_cache',
    'risk_analytics_cache','sector_breadth_history','strategy_config',
    'trade_log','trade_queue']
  LOOP
    EXECUTE format('DROP POLICY IF EXISTS "service_all_%1$s" ON %1$I', t);
    EXECUTE format('DROP POLICY IF EXISTS "auth_read_%1$s" ON %1$I', t);
    EXECUTE format('CREATE POLICY "service_all_%1$s" ON %1$I FOR ALL TO service_role USING (true) WITH CHECK (true)', t);
    EXECUTE format('CREATE POLICY "auth_read_%1$s" ON %1$I FOR SELECT TO authenticated USING (true)', t);
  END LOOP;
END $$;
