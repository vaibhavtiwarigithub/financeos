-- Migration 148: live kill-switch data path + atomic SELL idempotency
-- F6: kill switches now read live_account_snapshots when live_auto_enabled=true
--     (no schema change needed — live_account_snapshots already exists)
-- Atomic SELL: partial unique index prevents duplicate autonomous SELL proposals
--   at the DB level, closing the race window between pre-insert check and insert.

-- Partial unique index: at most one active autonomous SELL per (symbol, market).
-- Status transitions (filled, cancelled, manual_review_required) remove the row
-- from the index so a new SELL can be submitted after the prior one closes.
CREATE UNIQUE INDEX IF NOT EXISTS trade_proposals_active_sell_uniq
  ON public.trade_proposals (symbol, market)
  WHERE side = 'sell' AND status IN ('pending_review', 'queued_auto');
