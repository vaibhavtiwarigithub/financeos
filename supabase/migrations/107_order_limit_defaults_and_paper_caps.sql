-- Order-limit defaults (owner-chosen) + paper-book caps.
--
-- LIVE caps set to owner values: per-trade US $500 / India Rs 20000; daily US $5000 /
-- India Rs 30000. (Raises the US live per-order cap 50 -> 500 per explicit owner request.)
--
-- PAPER caps are separate columns scaled to the paper NAV ($10k US / Rs 1M India) so
-- they bound outliers without freezing the strategy (paper positions target ~15% of NAV):
--   per-trade ~25% of NAV, daily ~50% of NAV. Owner-editable in Settings.

-- Live defaults
update strategy_config set
  max_order_notional_usd = coalesce(max_order_notional_usd, 500),
  max_order_notional_inr = coalesce(max_order_notional_inr, 20000),
  max_daily_notional_usd = coalesce(max_daily_notional_usd, 5000),
  max_daily_notional_inr = coalesce(max_daily_notional_inr, 30000);
-- Explicit owner override of the existing US live per-order cap (was 50).
update strategy_config set max_order_notional_usd = 500 where max_order_notional_usd = 50;

-- Paper caps (separate columns; NULL = not enforced on paper)
alter table strategy_config
  add column if not exists max_order_notional_usd_paper numeric,
  add column if not exists max_order_notional_inr_paper numeric,
  add column if not exists max_daily_notional_usd_paper numeric,
  add column if not exists max_daily_notional_inr_paper numeric;

update strategy_config set
  max_order_notional_usd_paper = coalesce(max_order_notional_usd_paper, 2500),
  max_order_notional_inr_paper = coalesce(max_order_notional_inr_paper, 250000),
  max_daily_notional_usd_paper = coalesce(max_daily_notional_usd_paper, 5000),
  max_daily_notional_inr_paper = coalesce(max_daily_notional_inr_paper, 500000);

comment on column strategy_config.max_order_notional_usd_paper is 'Per-trade paper notional cap (USD), scaled to paper NAV. Owner-set. NULL = not enforced.';
comment on column strategy_config.max_daily_notional_usd_paper is 'Daily cumulative paper notional cap (USD). Owner-set. NULL = not enforced.';
