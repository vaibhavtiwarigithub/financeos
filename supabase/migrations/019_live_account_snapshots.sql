-- Restore the original live-account snapshot table (migration
-- 20260629193036 / 019_live_account_snapshots), missing from the tracked chain.
-- It contains account balances and positions; keep RLS enabled and require
-- callers to provide an explicit account_id (never default a row to an account).

CREATE TABLE IF NOT EXISTS public.live_account_snapshots (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id TEXT NOT NULL,
  equity NUMERIC,
  buying_power NUMERIC,
  portfolio_value NUMERIC,
  position_count INTEGER,
  positions_json JSONB,
  captured_at TIMESTAMPTZ DEFAULT now(),
  nickname TEXT,
  account_type TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS live_account_snapshots_account_id_unique
  ON public.live_account_snapshots (account_id);

ALTER TABLE public.live_account_snapshots ENABLE ROW LEVEL SECURITY;
