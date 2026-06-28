-- Fix overly permissive RLS policies on paper trading tables.
-- Original policies used USING (true) which grants all roles full access.
-- Service role bypasses RLS entirely, so routes are unaffected.
-- This blocks direct anon/authenticated access to raw paper data.

-- paper_portfolio
DROP POLICY IF EXISTS "service_only" ON paper_portfolio;
CREATE POLICY "service_role_only" ON paper_portfolio
  USING (auth.role() = 'service_role')
  WITH CHECK (auth.role() = 'service_role');

-- paper_positions
DROP POLICY IF EXISTS "service_only" ON paper_positions;
CREATE POLICY "service_role_only" ON paper_positions
  USING (auth.role() = 'service_role')
  WITH CHECK (auth.role() = 'service_role');

-- paper_trades
DROP POLICY IF EXISTS "service_only" ON paper_trades;
CREATE POLICY "service_role_only" ON paper_trades
  USING (auth.role() = 'service_role')
  WITH CHECK (auth.role() = 'service_role');

-- paper_performance
DROP POLICY IF EXISTS "service_only" ON paper_performance;
CREATE POLICY "service_role_only" ON paper_performance
  USING (auth.role() = 'service_role')
  WITH CHECK (auth.role() = 'service_role');

-- agent_signals
DROP POLICY IF EXISTS "service_only" ON agent_signals;
CREATE POLICY "service_role_only" ON agent_signals
  USING (auth.role() = 'service_role')
  WITH CHECK (auth.role() = 'service_role');

-- research_packets
DROP POLICY IF EXISTS "service_only" ON research_packets;
CREATE POLICY "service_role_only" ON research_packets
  USING (auth.role() = 'service_role')
  WITH CHECK (auth.role() = 'service_role');

-- learning_log
DROP POLICY IF EXISTS "service_only" ON learning_log;
CREATE POLICY "service_role_only" ON learning_log
  USING (auth.role() = 'service_role')
  WITH CHECK (auth.role() = 'service_role');

-- signal_weights
DROP POLICY IF EXISTS "service_only" ON signal_weights;
CREATE POLICY "service_role_only" ON signal_weights
  USING (auth.role() = 'service_role')
  WITH CHECK (auth.role() = 'service_role');
