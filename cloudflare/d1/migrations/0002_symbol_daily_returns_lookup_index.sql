-- First indexed access path: table/symbol/session/point-in-time queries.
-- Build on its own UTC day and inspect meta.rows_written; the current 99k rows
-- should fit under D1 Free's hard 100k daily row-write ceiling.
CREATE INDEX IF NOT EXISTS symbol_daily_returns_lookup_idx
  ON symbol_daily_returns (market, symbol, session_date, available_at_us DESC, id DESC);
