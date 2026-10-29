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
  realized_pnl_pct numeric,
  highest_price numeric,
  stop_loss numeric,
  take_profit numeric,
  outcome text CHECK (outcome IN ('win', 'loss', 'breakeven')),
  -- Signal accuracy breakdown
  fundamental_score numeric,
  technical_score numeric,
  sentiment_score numeric,
  macro_score numeric,
  executed_at timestamptz DEFAULT now(),
  closed_at timestamptz,
  exit_at timestamptz
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
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

-- Measure-only, per-archetype rank-IC evidence. The deployed table predates
-- the tracked migration chain; keep its verified shape reproducible so the
-- later cohort migration can add its explicit population label.
CREATE TABLE IF NOT EXISTS archetype_ic_runs (
  id bigserial PRIMARY KEY,
  as_of_date date NOT NULL,
  market text NOT NULL CHECK (market IN ('us', 'india')),
  setup_type text NOT NULL,
  horizon_days integer NOT NULL CHECK (horizon_days IN (2, 5, 10, 20, 60, 120)),
  qualifying_sessions integer NOT NULL CHECK (qualifying_sessions >= 0),
  observations integer NOT NULL CHECK (observations >= 0),
  rank_ic numeric,
  rank_ic_t numeric,
  champion_rank_ic numeric,
  ic_delta_vs_champion numeric,
  effective_observations numeric,
  status text NOT NULL CHECK (status IN ('insufficient_evidence', 'measured')),
  reason text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (as_of_date, market, setup_type, horizon_days)
);

CREATE INDEX IF NOT EXISTS archetype_ic_runs_lookup_idx
  ON archetype_ic_runs (market, setup_type, horizon_days, as_of_date DESC);

ALTER TABLE archetype_ic_runs ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE archetype_ic_runs FROM anon;
GRANT SELECT ON TABLE archetype_ic_runs TO authenticated;
GRANT ALL PRIVILEGES ON TABLE archetype_ic_runs TO service_role;
GRANT USAGE, SELECT ON SEQUENCE archetype_ic_runs_id_seq TO authenticated, service_role;
CREATE POLICY archetype_ic_runs_owner_read ON archetype_ic_runs
  FOR SELECT TO authenticated
  USING ((SELECT auth.jwt()) ->> 'email' = 'vterminater@gmail.com');

-- RLS: owner only
ALTER TABLE paper_portfolio ENABLE ROW LEVEL SECURITY;
ALTER TABLE paper_positions ENABLE ROW LEVEL SECURITY;
ALTER TABLE paper_trades ENABLE ROW LEVEL SECURITY;
ALTER TABLE paper_performance ENABLE ROW LEVEL SECURITY;

CREATE POLICY "service_only" ON paper_portfolio USING (true);
CREATE POLICY "service_only" ON paper_positions USING (true);
CREATE POLICY "service_only" ON paper_trades USING (true);
CREATE POLICY "service_only" ON paper_performance USING (true);
