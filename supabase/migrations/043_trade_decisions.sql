-- uploaded CSV files tracking
CREATE TABLE IF NOT EXISTS uploaded_trade_files (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  filename TEXT NOT NULL,
  file_hash TEXT NOT NULL UNIQUE,
  trade_count INTEGER DEFAULT 0,
  duplicate_count INTEGER DEFAULT 0,
  date_range_start DATE,
  date_range_end DATE,
  broker TEXT NOT NULL DEFAULT 'robinhood',
  uploaded_at TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE uploaded_trade_files ENABLE ROW LEVEL SECURITY;
CREATE POLICY "service_all_utf" ON uploaded_trade_files FOR ALL TO service_role USING (true) WITH CHECK (true);
CREATE POLICY "auth_read_utf" ON uploaded_trade_files FOR SELECT TO authenticated USING (true);

-- trade decision audit log
CREATE TABLE IF NOT EXISTS trade_decisions (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  source_file TEXT NOT NULL DEFAULT 'robinhood_mcp',
  symbol TEXT NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('buy', 'sell')),
  qty NUMERIC NOT NULL,
  exec_price NUMERIC NOT NULL,
  exec_date DATE NOT NULL,
  -- post-decision prices
  price_1d_after NUMERIC,
  price_1w_after NUMERIC,
  price_1m_after NUMERIC,
  price_3m_after NUMERIC,
  -- scoring
  outcome_score NUMERIC,
  pattern_tags TEXT[] DEFAULT '{}',
  llm_analysis TEXT,
  -- macro context
  macro_fed_rate NUMERIC,
  macro_market_regime TEXT,
  macro_event_tag TEXT,
  -- metadata
  price_data_available BOOLEAN DEFAULT TRUE,
  enrichment_status TEXT DEFAULT 'pending' CHECK (enrichment_status IN ('pending', 'enriched', 'no_data')),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  -- cross-source dedup
  UNIQUE (symbol, action, exec_date, exec_price, qty)
);

ALTER TABLE trade_decisions ENABLE ROW LEVEL SECURITY;
CREATE POLICY "service_all_td" ON trade_decisions FOR ALL TO service_role USING (true) WITH CHECK (true);
CREATE POLICY "auth_read_td" ON trade_decisions FOR SELECT TO authenticated USING (true);

CREATE INDEX IF NOT EXISTS idx_td_symbol ON trade_decisions (symbol);
CREATE INDEX IF NOT EXISTS idx_td_exec_date ON trade_decisions (exec_date DESC);
CREATE INDEX IF NOT EXISTS idx_td_source ON trade_decisions (source_file);
CREATE INDEX IF NOT EXISTS idx_td_enrichment ON trade_decisions (enrichment_status);
