-- Phase 4: Multi-market learning (US + India).
-- Market is a TAG/dimension, not a fork. Every paper pool, position, trade,
-- performance row, signal, score-history row and strategy champion carries a
-- `market` (and where money is involved, a `currency`). Nothing is ever summed
-- across currencies. India (INR) gets its own paper pool + its own champion
-- weights so a bad India run can never shift US scoring.
--
-- Fully additive + idempotent. Safe to run once; safe to re-run.

-- ── paper_portfolio: one pool per market ────────────────────────────────────
ALTER TABLE paper_portfolio ADD COLUMN IF NOT EXISTS market   text NOT NULL DEFAULT 'us';
ALTER TABLE paper_portfolio ADD COLUMN IF NOT EXISTS currency text NOT NULL DEFAULT 'USD';
-- Existing singleton is the US/USD pool (covered by the defaults above).
CREATE UNIQUE INDEX IF NOT EXISTS paper_portfolio_market_key ON paper_portfolio(market);
-- India ₹ pool: 1,000,000 INR starting cash (the US $10k analog).
INSERT INTO paper_portfolio (cash_balance, nav, market, currency)
SELECT 1000000, 1000000, 'india', 'INR'
WHERE NOT EXISTS (SELECT 1 FROM paper_portfolio WHERE market = 'india');

-- ── paper_positions ─────────────────────────────────────────────────────────
ALTER TABLE paper_positions ADD COLUMN IF NOT EXISTS market   text NOT NULL DEFAULT 'us';
ALTER TABLE paper_positions ADD COLUMN IF NOT EXISTS currency text NOT NULL DEFAULT 'USD';

-- ── paper_trades ────────────────────────────────────────────────────────────
ALTER TABLE paper_trades ADD COLUMN IF NOT EXISTS market   text NOT NULL DEFAULT 'us';
ALTER TABLE paper_trades ADD COLUMN IF NOT EXISTS currency text NOT NULL DEFAULT 'USD';

-- ── paper_order_events (may not exist in every env) ─────────────────────────
DO $$
BEGIN
  IF to_regclass('public.paper_order_events') IS NOT NULL THEN
    EXECUTE 'ALTER TABLE paper_order_events ADD COLUMN IF NOT EXISTS market text NOT NULL DEFAULT ''us''';
  END IF;
END $$;

-- ── paper_performance: NAV snapshot is now per-market ───────────────────────
-- The old unique was on (date) alone — a single global curve. Make it
-- (date, market) so US and India each keep their own daily NAV series.
ALTER TABLE paper_performance ADD COLUMN IF NOT EXISTS market text NOT NULL DEFAULT 'us';
ALTER TABLE paper_performance DROP CONSTRAINT IF EXISTS paper_performance_date_key;
CREATE UNIQUE INDEX IF NOT EXISTS paper_performance_date_market_key ON paper_performance(date, market);

-- ── agent_signals: tag market off asset_class ───────────────────────────────
ALTER TABLE agent_signals ADD COLUMN IF NOT EXISTS market text NOT NULL DEFAULT 'us';
UPDATE agent_signals SET market = 'india' WHERE asset_class = 'india' AND market <> 'india';

-- ── signal_score_history: tag market ────────────────────────────────────────
DO $$
BEGIN
  IF to_regclass('public.signal_score_history') IS NOT NULL THEN
    EXECUTE 'ALTER TABLE signal_score_history ADD COLUMN IF NOT EXISTS market text NOT NULL DEFAULT ''us''';
  END IF;
END $$;

-- ── strategy_versions: per-market champion weights ──────────────────────────
ALTER TABLE strategy_versions ADD COLUMN IF NOT EXISTS market text NOT NULL DEFAULT 'us';
-- Champion is enforced in app logic (index-only, not a DB unique), so a second
-- market can hold its own champion safely. Seed India's champion by cloning the
-- current US champion as a PRIOR — India scores off proven weights until it has
-- its own 10+ closed trades and the LearnerAgent promotes an India-specific set.
INSERT INTO strategy_versions
  (version, name, description, universe, horizon_days_min, horizon_days_max,
   direction, entry_rules, exit_rules, weights_snapshot, state, is_champion,
   promoted_at, market, notes)
SELECT
  version || '-india', name || ' (India)', description, 'india_equity',
  horizon_days_min, horizon_days_max, direction, entry_rules, exit_rules,
  weights_snapshot, state, true, now(), 'india',
  'Cloned from US champion as India prior (Phase 4 multi-market). Diverges once India has its own closed-trade history.'
FROM strategy_versions
WHERE is_champion = true AND market = 'us'
  AND NOT EXISTS (SELECT 1 FROM strategy_versions WHERE market = 'india' AND is_champion = true)
ORDER BY promoted_at DESC NULLS LAST
LIMIT 1;
