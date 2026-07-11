-- Idempotent autonomous claim: at most ONE autonomous_live proposal may exist
-- per (signal_id, market). Concurrent or repeated autonomous-live cron runs that
-- try to create a second proposal for the same signal now fail with a unique
-- violation instead of both reserving budget and placing an order.
CREATE UNIQUE INDEX IF NOT EXISTS trade_proposals_auto_signal_uniq
  ON public.trade_proposals (signal_id, market)
  WHERE execution_mode = 'autonomous_live' AND signal_id IS NOT NULL;
