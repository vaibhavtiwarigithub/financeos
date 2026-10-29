-- Restore the deployed legacy trade-log and trade-queue schemas that the
-- early RLS-policy migration (053) expects, but the tracked chain omitted.
-- This is idempotent on production, where both tables already exist.

CREATE TABLE IF NOT EXISTS public.trade_log (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  ticker TEXT,
  action TEXT,
  quantity NUMERIC,
  executed_price NUMERIC,
  agent TEXT DEFAULT 'TraderAgent',
  mode TEXT,
  approved_by_user BOOLEAN DEFAULT false,
  robinhood_order_id TEXT,
  outcome_pnl NUMERIC,
  outcome_correct BOOLEAN,
  resolved_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT now(),
  symbol TEXT,
  order_side TEXT,
  qty NUMERIC,
  fill_price NUMERIC,
  analyst_score INTEGER,
  rationale TEXT,
  outcome TEXT,
  executed_at TIMESTAMPTZ DEFAULT now()
);

ALTER TABLE public.trade_log ENABLE ROW LEVEL SECURITY;

CREATE TABLE IF NOT EXISTS public.trade_queue (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  ticker TEXT,
  action TEXT,
  quantity NUMERIC,
  estimated_price NUMERIC,
  analyst_score NUMERIC,
  signal_snapshot JSONB,
  status TEXT DEFAULT 'pending',
  user_decision_at TIMESTAMPTZ,
  rejection_reason TEXT,
  created_at TIMESTAMPTZ DEFAULT now(),
  symbol TEXT,
  order_side TEXT,
  order_type TEXT DEFAULT 'market',
  qty NUMERIC,
  limit_price NUMERIC,
  signal_id UUID,
  rationale TEXT,
  robinhood_order_id TEXT
);

ALTER TABLE public.trade_queue ENABLE ROW LEVEL SECURITY;
