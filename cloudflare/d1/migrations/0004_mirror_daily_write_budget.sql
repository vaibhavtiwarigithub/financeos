-- Bound live mirror ingestion independently of D1's account-wide hard limit.
-- The Worker reserves incoming source rows atomically; the 15,000-row ceiling
-- leaves headroom for table, indexes, and status accounting.
ALTER TABLE archive_dataset_status ADD COLUMN mirror_budget_day TEXT;
ALTER TABLE archive_dataset_status ADD COLUMN mirror_rows_today INTEGER NOT NULL DEFAULT 0;
