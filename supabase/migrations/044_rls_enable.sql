-- Enable RLS on tables that had it explicitly disabled in migrations 034-037.
-- Pattern: service_role gets full access (all agent routes use service client).
--          authenticated users get SELECT only (read-only for audit trail).
--          Mutations come exclusively through service_role (agent routes).

-- paper_order_events (034)
ALTER TABLE paper_order_events ENABLE ROW LEVEL SECURITY;
CREATE POLICY "service_all_poe"  ON paper_order_events FOR ALL      TO service_role  USING (true) WITH CHECK (true);
CREATE POLICY "auth_read_poe"    ON paper_order_events FOR SELECT    TO authenticated USING (true);

-- evidence_records (035)
ALTER TABLE evidence_records ENABLE ROW LEVEL SECURITY;
CREATE POLICY "service_all_er"   ON evidence_records   FOR ALL      TO service_role  USING (true) WITH CHECK (true);
CREATE POLICY "auth_read_er"     ON evidence_records   FOR SELECT    TO authenticated USING (true);

-- corporate_actions (035)
ALTER TABLE corporate_actions ENABLE ROW LEVEL SECURITY;
CREATE POLICY "service_all_ca"   ON corporate_actions  FOR ALL      TO service_role  USING (true) WITH CHECK (true);
CREATE POLICY "auth_read_ca"     ON corporate_actions  FOR SELECT    TO authenticated USING (true);

-- strategy_versions (036)
ALTER TABLE strategy_versions ENABLE ROW LEVEL SECURITY;
CREATE POLICY "service_all_sv"   ON strategy_versions  FOR ALL      TO service_role  USING (true) WITH CHECK (true);
CREATE POLICY "auth_read_sv"     ON strategy_versions  FOR SELECT    TO authenticated USING (true);

-- experiment_runs (036)
ALTER TABLE experiment_runs ENABLE ROW LEVEL SECURITY;
CREATE POLICY "service_all_exr"  ON experiment_runs    FOR ALL      TO service_role  USING (true) WITH CHECK (true);
CREATE POLICY "auth_read_exr"    ON experiment_runs    FOR SELECT    TO authenticated USING (true);

-- trade_proposals (037)
ALTER TABLE trade_proposals ENABLE ROW LEVEL SECURITY;
CREATE POLICY "service_all_tp"   ON trade_proposals    FOR ALL      TO service_role  USING (true) WITH CHECK (true);
CREATE POLICY "auth_read_tp"     ON trade_proposals    FOR SELECT    TO authenticated USING (true);

-- decision_journal (037)
ALTER TABLE decision_journal ENABLE ROW LEVEL SECURITY;
CREATE POLICY "service_all_dj"   ON decision_journal   FOR ALL      TO service_role  USING (true) WITH CHECK (true);
CREATE POLICY "auth_read_dj"     ON decision_journal   FOR SELECT    TO authenticated USING (true);
