-- Queryable cold-history mirror for Kairos. Supabase remains the live writer
-- until parity is proven; R2 keeps the immutable verified source archive.
CREATE TABLE IF NOT EXISTS symbol_daily_returns (
  id INTEGER PRIMARY KEY NOT NULL,
  symbol TEXT NOT NULL,
  market TEXT NOT NULL CHECK (market IN ('us', 'india')),
  session_date TEXT NOT NULL,
  previous_session_date TEXT NOT NULL,
  available_at TEXT NOT NULL,
  available_at_us INTEGER NOT NULL,
  source TEXT NOT NULL,
  price_basis TEXT NOT NULL CHECK (price_basis IN ('adjusted_close', 'raw_close')),
  close TEXT NOT NULL,
  previous_close TEXT NOT NULL,
  simple_return TEXT NOT NULL,
  input_fingerprint TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS archive_dataset_status (
  dataset TEXT PRIMARY KEY NOT NULL,
  schema_version INTEGER NOT NULL,
  source_snapshot_at TEXT NOT NULL,
  source_ordered_digest TEXT NOT NULL,
  expected_rows INTEGER NOT NULL,
  verified_rows INTEGER NOT NULL DEFAULT 0,
  state TEXT NOT NULL CHECK (state IN ('loading', 'verified', 'degraded')),
  verified_at TEXT
);
