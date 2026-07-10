-- Per-market autonomous mode toggles + fix missing trade_proposals.market
-- Also retroactively creates placeholder files for 139/140 which were applied
-- via MCP in the prior session but had no SQL files on disk.

-- 1. Per-market mode columns on strategy_config
ALTER TABLE public.strategy_config
  ADD COLUMN IF NOT EXISTS live_auto_mode_us TEXT NOT NULL DEFAULT 'manual'
    CONSTRAINT chk_live_auto_mode_us CHECK (live_auto_mode_us IN ('off', 'manual', 'autonomous')),
  ADD COLUMN IF NOT EXISTS live_auto_mode_india TEXT NOT NULL DEFAULT 'manual'
    CONSTRAINT chk_live_auto_mode_india CHECK (live_auto_mode_india IN ('off', 'manual', 'autonomous'));

-- 2. Fix missing market column on trade_proposals (was omitted from migration 139)
ALTER TABLE public.trade_proposals
  ADD COLUMN IF NOT EXISTS market TEXT;

CREATE INDEX IF NOT EXISTS trade_proposals_market_exec_idx
  ON public.trade_proposals (market, execution_mode, created_at DESC);
