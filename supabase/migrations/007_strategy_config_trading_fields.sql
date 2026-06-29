-- Add missing fields to strategy_config that trade route requires
ALTER TABLE strategy_config
  ADD COLUMN IF NOT EXISTS trading_enabled boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS max_daily_trades integer NOT NULL DEFAULT 2;

-- Update existing row
UPDATE strategy_config SET
  trading_enabled = false,
  max_daily_trades = 2
WHERE trading_enabled IS NULL OR max_daily_trades IS NULL;
