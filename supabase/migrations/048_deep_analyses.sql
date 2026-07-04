-- Migration 048: deep_analyses
-- Stores on-demand adversarial multi-agent deep-dive analyses per symbol.
-- Analyst layer → Bull/Bear debate → Risk debate → Portfolio Manager verdict.

CREATE TABLE IF NOT EXISTS deep_analyses (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  symbol      text NOT NULL,
  verdict     text,                       -- BUY | HOLD | SELL | PASS
  conviction  int,                        -- 0..100
  summary     text,                       -- Portfolio Manager final rationale
  reports     jsonb NOT NULL DEFAULT '{}'::jsonb,  -- per-agent reports
  model       text,
  tokens_in   int NOT NULL DEFAULT 0,
  tokens_out  int NOT NULL DEFAULT 0,
  cost_usd    numeric NOT NULL DEFAULT 0,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS deep_analyses_symbol_created ON deep_analyses (symbol, created_at DESC);

ALTER TABLE deep_analyses ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "service_all_da" ON deep_analyses;
DROP POLICY IF EXISTS "auth_read_da"   ON deep_analyses;
CREATE POLICY "service_all_da" ON deep_analyses FOR ALL TO service_role USING (true) WITH CHECK (true);
CREATE POLICY "auth_read_da"   ON deep_analyses FOR SELECT TO authenticated USING (true);
