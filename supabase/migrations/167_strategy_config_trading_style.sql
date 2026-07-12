-- Trading Style preset (Swing / Position / Long-term) on strategy_config.
--
-- trading_style     : user-facing horizon preset. DEFAULT 'position' so existing
--                     rows read as the balanced 10-day default. Display + drives
--                     the preset knobs written alongside it by the settings UI.
-- target_hold_days  : the holding-horizon the position-monitor time-stop prefers
--                     WHEN no promoted champion governs horizon. Nullable — unset
--                     means "let the genome decide" (DEFAULT_GENOME horizon 10, or
--                     the learned champion horizon once one is promoted). We never
--                     overwrite the learned genome from here; this is a default
--                     that yields to the LearnerAgent's champion.
--
-- NOTE: This system is once-daily swing/position — these presets set holding
-- horizon + thresholds, they do NOT enable intraday/day-trading.

alter table strategy_config
  add column if not exists trading_style text default 'position',
  add column if not exists target_hold_days int;

-- Backfill existing rows so the default row reflects the 'position' preset.
update strategy_config set trading_style = 'position' where trading_style is null;
