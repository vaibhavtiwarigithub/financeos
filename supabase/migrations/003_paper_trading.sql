-- Paper Trading Engine
-- Run this in Supabase SQL editor

-- Paper portfolio: virtual cash + NAV tracking
CREATE TABLE IF NOT EXISTS paper_portfolio (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  cash_balance numeric DEFAULT 10000,
  nav numeric DEFAULT 10000,
  total_invested numeric DEFAULT 0,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

-- Seed one portfolio with $10k virtual cash
INSERT INTO paper_portfolio (cash_balance, nav) VALUES (10000, 10000)
ON CONFLICT DO NOTHING;

-- Paper positions: virtual holdings
CREATE TABLE IF NOT EXISTS paper_positions (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  symbol text NOT NULL,
  qty numeric NOT NULL,
  avg_cost numeric NOT NULL,
  current_price numeric,
  opened_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

-- Paper trades: every virtual fill
CREATE TABLE IF NOT EXISTS paper_trades (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  symbol text NOT NULL,
  order_side text NOT NULL CHECK (order_side IN ('buy', 'sell')),
  qty numeric NOT NULL,
  fill_price numeric NOT NULL,
  total_value numeric GENERATED ALWAYS AS (qty * fill_price) STORED,
  signal_id uuid REFERENCES agent_signals(id),
  analyst_score numeric,
  direction text,
  rationale text,
  -- Outcome tracking (filled when position closes)
  exit_price numeric,
  realized_pnl numeric,
  pnl_pct numeric,
  outcome text CHECK (outcome IN ('win', 'loss', 'breakeven')),
  -- Signal accuracy breakdown
  fundamental_score numeric,
  technical_score numeric,
  sentiment_score numeric,
  macro_score numeric,
  executed_at timestamptz DEFAULT now(),
  closed_at timestamptz
);

-- Daily NAV snapshots for chart
CREATE TABLE IF NOT EXISTS paper_performance (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  date date NOT NULL UNIQUE,
  nav numeric NOT NULL,
  cash_balance numeric NOT NULL,
  positions_value numeric DEFAULT 0,
  daily_pnl numeric DEFAULT 0,
  total_pnl numeric DEFAULT 0,
  total_pnl_pct numeric DEFAULT 0,
  win_count integer DEFAULT 0,
  loss_count integer DEFAULT 0,
  win_rate numeric DEFAULT 0,
  created_at timestamptz DEFAULT now()
);

-- RLS: owner only
ALTER TABLE paper_portfolio ENABLE ROW LEVEL SECURITY;
ALTER TABLE paper_positions ENABLE ROW LEVEL SECURITY;
ALTER TABLE paper_trades ENABLE ROW LEVEL SECURITY;
ALTER TABLE paper_performance ENABLE ROW LEVEL SECURITY;

CREATE POLICY "service_only" ON paper_portfolio USING (true);
CREATE POLICY "service_only" ON paper_positions USING (true);
CREATE POLICY "service_only" ON paper_trades USING (true);
CREATE POLICY "service_only" ON paper_performance USING (true);
