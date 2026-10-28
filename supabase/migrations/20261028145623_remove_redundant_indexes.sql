-- Remove only verified duplicate indexes. The retained objects enforce the
-- same lookup and uniqueness contracts as before.
DROP INDEX IF EXISTS public.er_gate_idx;
DROP INDEX IF EXISTS public.er_strategy_idx;

-- watchlist_user_id_ticker_key remains UNIQUE (user_id, symbol), which is the
-- conflict target used by the app's watchlist upserts.
ALTER TABLE public.watchlist
  DROP CONSTRAINT IF EXISTS watchlist_user_symbol_uniq;
