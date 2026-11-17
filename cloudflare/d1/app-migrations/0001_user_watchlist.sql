-- First Kairos app-domain table hosted in Cloudflare D1.
-- The user ID is the stable UUID issued by the existing authentication layer;
-- authentication-provider records remain outside D1 during this migration.
CREATE TABLE IF NOT EXISTS user_watchlist (
  id TEXT PRIMARY KEY NOT NULL,
  user_id TEXT NOT NULL,
  symbol TEXT NOT NULL,
  market TEXT NOT NULL CHECK (market IN ('us', 'india')),
  added_at TEXT NOT NULL,
  UNIQUE (user_id, symbol, market)
);

CREATE INDEX IF NOT EXISTS user_watchlist_user_added_idx
  ON user_watchlist (user_id, added_at DESC);
