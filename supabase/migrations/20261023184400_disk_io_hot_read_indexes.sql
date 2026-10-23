-- Supabase Disk I/O warning, 2026-10-23: match measured production read shapes.
-- Version matches the production migration runner's recorded version.
-- Additive access paths only: no rows, grants, RLS, score or trading changes.
-- Fail rather than waiting indefinitely behind a busy production writer.
SET LOCAL lock_timeout = '2s';
SET LOCAL statement_timeout = '45s';

-- Global latest-score reader cannot use the existing (symbol, created_at) order.
-- pg_stat_statements recorded 1,337,528 temporary blocks from its sort shape.
CREATE INDEX IF NOT EXISTS signal_score_history_created_desc_idx
  ON public.signal_score_history (created_at DESC);

-- Cross-symbol return readers filter market and order by availability. Existing
-- (market, symbol, session_date, available_at) needs a full scan/sort here.
CREATE INDEX IF NOT EXISTS symbol_daily_returns_market_available_idx
  ON public.symbol_daily_returns (market, available_at DESC);

-- Router evaluation proves actual provider calls by run_id, not provider/intent.
CREATE INDEX IF NOT EXISTS provider_call_ledger_run_id_idx
  ON public.provider_call_ledger (run_id);
