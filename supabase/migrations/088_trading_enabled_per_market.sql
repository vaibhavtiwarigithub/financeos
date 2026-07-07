-- Per-market live-trading enable/disable, independent of viewing account data
-- and independent of the Kite/Robinhood connection kill-switches. Default
-- true so existing behavior (gated only by global trading_enabled) is
-- unchanged until the user explicitly flips one off.
alter table strategy_config add column if not exists trading_enabled_us boolean not null default true;
alter table strategy_config add column if not exists trading_enabled_india boolean not null default true;
