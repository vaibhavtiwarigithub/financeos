-- Second access path for the deliberate market-wide policy-event scan.
-- Run on a separate UTC day from the lookup-index build and verify metering.
CREATE INDEX IF NOT EXISTS symbol_daily_returns_market_date_idx
  ON symbol_daily_returns (market, session_date, available_at_us DESC, id DESC);
