-- Migration 050: mentor_insights
-- Stores personalized coaching from the MentorAgent (true tool-use AI agent):
-- grounded in the user's behavior + learning progress + market regime + principles.

CREATE TABLE IF NOT EXISTS mentor_insights (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  grade          int,
  confidence     numeric,
  strengths      jsonb NOT NULL DEFAULT '[]'::jsonb,
  focus_areas    jsonb NOT NULL DEFAULT '[]'::jsonb,
  lesson         text,
  market_note    text,
  next_milestone text,
  model          text,
  tokens_in      int NOT NULL DEFAULT 0,
  tokens_out     int NOT NULL DEFAULT 0,
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS mentor_insights_created ON mentor_insights (created_at DESC);
ALTER TABLE mentor_insights ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "service_all_mi" ON mentor_insights;
DROP POLICY IF EXISTS "auth_read_mi" ON mentor_insights;
CREATE POLICY "service_all_mi" ON mentor_insights FOR ALL TO service_role USING (true) WITH CHECK (true);
CREATE POLICY "auth_read_mi"   ON mentor_insights FOR SELECT TO authenticated USING (true);
