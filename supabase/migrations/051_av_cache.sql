-- Migration 051: av_cache
-- Per-day Alpha Vantage response cache. AV free tier = 25 calls/day, so we must
-- never re-spend a call for the same (function, symbol) within a day, and must
-- fall back to the last-known payload when AV throttles — keeping inputs complete.

CREATE TABLE IF NOT EXISTS av_cache (
  cache_key   text NOT NULL,          -- e.g. 'RSI:NVDA', 'OVERVIEW:AAPL'
  cache_date  date NOT NULL DEFAULT CURRENT_DATE,
  payload     jsonb NOT NULL,
  fetched_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (cache_key, cache_date)
);
CREATE INDEX IF NOT EXISTS av_cache_key_recent ON av_cache (cache_key, cache_date DESC);
ALTER TABLE av_cache ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "service_all_avc" ON av_cache;
CREATE POLICY "service_all_avc" ON av_cache FOR ALL TO service_role USING (true) WITH CHECK (true);
