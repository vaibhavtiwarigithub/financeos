-- Per-market live per-order notional caps.
-- Splits the single USD-shaped max_order_notional into per-currency caps so the
-- India (INR) live path is not governed by a USD number (₹50 would block every
-- order; $50 is sensible for US).
--
-- Additive + non-destructive. max_order_notional is kept as a DEPRECATED USD
-- read-through for one release so already-deployed code keeps working. Live-money
-- routes fail closed when their market's cap is unresolvable.

alter table strategy_config
  add column if not exists max_order_notional_usd numeric,
  add column if not exists max_order_notional_inr numeric;

-- Backfill USD from the existing single cap (default 50) so US behavior is unchanged.
update strategy_config
  set max_order_notional_usd = coalesce(max_order_notional, 50)
  where max_order_notional_usd is null;

-- INR intentionally left NULL: the India (Kite) live path fail-closes until the
-- owner sets an INR cap in Settings. No trusted Kite equity fallback is defined,
-- so a missing INR cap must refuse India live orders rather than run uncapped.

comment on column strategy_config.max_order_notional_usd is 'Per-order live notional cap for US market (USD). Owner-set in Settings. Fail-closed if unresolvable.';
comment on column strategy_config.max_order_notional_inr is 'Per-order live notional cap for India market (INR). Owner-set in Settings. NULL = India live orders refused (fail-closed).';
comment on column strategy_config.max_order_notional is 'DEPRECATED: legacy single USD cap. Use max_order_notional_usd. Kept one release as a read-through fallback.';
