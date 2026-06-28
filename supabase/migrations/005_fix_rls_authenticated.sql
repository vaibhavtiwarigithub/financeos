-- Fix RLS policies broken by 004_fix_rls_policies.sql.
-- Server client uses anon key + session cookie (auth.role() = 'authenticated').
-- Service role is NOT used by the app client, so 'service_role' check blocked everything.
-- Correct policy: authenticated users only. Route-level getUser() is the real auth guard.

-- paper_portfolio
DROP POLICY IF EXISTS "service_role_only" ON paper_portfolio;
CREATE POLICY "authenticated_only" ON paper_portfolio
  USING (auth.role() = 'authenticated')
  WITH CHECK (auth.role() = 'authenticated');

-- paper_positions
DROP POLICY IF EXISTS "service_role_only" ON paper_positions;
CREATE POLICY "authenticated_only" ON paper_positions
  USING (auth.role() = 'authenticated')
  WITH CHECK (auth.role() = 'authenticated');

-- paper_trades
DROP POLICY IF EXISTS "service_role_only" ON paper_trades;
CREATE POLICY "authenticated_only" ON paper_trades
  USING (auth.role() = 'authenticated')
  WITH CHECK (auth.role() = 'authenticated');

-- paper_performance
DROP POLICY IF EXISTS "service_role_only" ON paper_performance;
CREATE POLICY "authenticated_only" ON paper_performance
  USING (auth.role() = 'authenticated')
  WITH CHECK (auth.role() = 'authenticated');

-- agent_signals
DROP POLICY IF EXISTS "service_role_only" ON agent_signals;
CREATE POLICY "authenticated_only" ON agent_signals
  USING (auth.role() = 'authenticated')
  WITH CHECK (auth.role() = 'authenticated');

-- research_packets
DROP POLICY IF EXISTS "service_role_only" ON research_packets;
CREATE POLICY "authenticated_only" ON research_packets
  USING (auth.role() = 'authenticated')
  WITH CHECK (auth.role() = 'authenticated');

-- learning_log
DROP POLICY IF EXISTS "service_role_only" ON learning_log;
CREATE POLICY "authenticated_only" ON learning_log
  USING (auth.role() = 'authenticated')
  WITH CHECK (auth.role() = 'authenticated');

-- signal_weights
DROP POLICY IF EXISTS "service_role_only" ON signal_weights;
CREATE POLICY "authenticated_only" ON signal_weights
  USING (auth.role() = 'authenticated')
  WITH CHECK (auth.role() = 'authenticated');
