-- 010: Multi-agent labels, LLM call log, earnings calendar cache

-- Tag which LLM agent produced each signal/trade
ALTER TABLE agent_signals ADD COLUMN IF NOT EXISTS agent_label text DEFAULT 'claude';
ALTER TABLE paper_trades  ADD COLUMN IF NOT EXISTS agent_label text DEFAULT 'claude';
ALTER TABLE research_packets ADD COLUMN IF NOT EXISTS agent_label text DEFAULT 'claude';

-- LLM call log: track every model call, tokens, cost
CREATE TABLE IF NOT EXISTS llm_call_log (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at   timestamptz DEFAULT now(),
  model        text NOT NULL,
  task_type    text NOT NULL, -- research | chat | summarize | trade | evaluate
  prompt_hash  text,          -- sha256 of prompt (not stored raw)
  tokens_in    integer DEFAULT 0,
  tokens_out   integer DEFAULT 0,
  cost_usd     numeric(10,6) DEFAULT 0,
  duration_ms  integer DEFAULT 0,
  success      boolean DEFAULT true,
  error_msg    text,
  symbol       text,
  agent_label  text DEFAULT 'claude',
  run_id       uuid  -- links to agent_runs if applicable
);

CREATE INDEX IF NOT EXISTS llm_call_log_created_idx ON llm_call_log(created_at DESC);
CREATE INDEX IF NOT EXISTS llm_call_log_model_idx   ON llm_call_log(model);

-- Earnings calendar cache (from API, refreshed daily)
CREATE TABLE IF NOT EXISTS earnings_calendar (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  symbol           text NOT NULL,
  report_date      date NOT NULL,
  report_time      text,  -- 'before_market' | 'after_market' | 'unknown'
  eps_estimate     numeric,
  eps_actual       numeric,
  revenue_estimate bigint,
  revenue_actual   bigint,
  fiscal_quarter   text,
  fiscal_year      integer,
  fetched_at       timestamptz DEFAULT now(),
  UNIQUE(symbol, report_date)
);

CREATE INDEX IF NOT EXISTS earnings_cal_date_idx   ON earnings_calendar(report_date);
CREATE INDEX IF NOT EXISTS earnings_cal_symbol_idx ON earnings_calendar(symbol);

-- Strategy templates (popular strategies: momentum, GARP, value, etc.)
CREATE TABLE IF NOT EXISTS strategy_templates (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text NOT NULL UNIQUE,
  description text,
  rules       jsonb NOT NULL DEFAULT '{}',
  created_at  timestamptz DEFAULT now()
);

-- Per-symbol strategy classification scores (updated by screener)
CREATE TABLE IF NOT EXISTS strategy_classifications (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  symbol       text NOT NULL,
  strategy_id  uuid REFERENCES strategy_templates(id),
  fit_score    numeric,  -- 0-100
  matched_at   timestamptz DEFAULT now(),
  UNIQUE(symbol, strategy_id)
);

-- RLS: admin/service access only for logs
ALTER TABLE llm_call_log           ENABLE ROW LEVEL SECURITY;
ALTER TABLE earnings_calendar      ENABLE ROW LEVEL SECURITY;
ALTER TABLE strategy_templates     ENABLE ROW LEVEL SECURITY;
ALTER TABLE strategy_classifications ENABLE ROW LEVEL SECURITY;

CREATE POLICY "service_all" ON llm_call_log           FOR ALL USING (true);
CREATE POLICY "service_all" ON earnings_calendar      FOR ALL USING (true);
CREATE POLICY "service_all" ON strategy_templates     FOR ALL USING (true);
CREATE POLICY "service_all" ON strategy_classifications FOR ALL USING (true);

-- Seed popular strategy templates
INSERT INTO strategy_templates (name, description, rules) VALUES
('Momentum',      'RSI>60, price above 50MA, revenue acceleration',
 '{"rsi_min":60,"above_ma50":true,"revenue_accel":true,"earnings_revision":"positive"}'),
('GARP',          'Growth at Reasonable Price: PEG<1, revenue growth >15%',
 '{"peg_max":1.0,"rev_growth_min":15,"margin_stable":true}'),
('Value',         'P/E below sector median, high FCF yield, insider buying',
 '{"pe_vs_sector":"below_median","fcf_yield_min":5,"insider_buying":true}'),
('Trend Follow',  'Price above 200MA, golden cross or near 52w high',
 '{"above_ma200":true,"ma50_above_ma200":true,"pct_from_52w_high_max":15}'),
('Mean Revert',   'RSI<30, Bollinger lower band, >15% below 52w high',
 '{"rsi_max":30,"bb_lower":true,"pct_below_52w_high_min":15}'),
('Quality',       'High ROE, low debt/equity, consistent earnings',
 '{"roe_min":15,"de_max":0.5,"earnings_consistency":true}'),
('CANSLIM-Lite',  'Quarterly EPS growth, new 52w high, institutional buying',
 '{"eps_qoq_growth":true,"near_52w_high":true,"institutional_increase":true}')
ON CONFLICT (name) DO NOTHING;
