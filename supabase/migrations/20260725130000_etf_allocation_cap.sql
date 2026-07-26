-- ETF allocation cap: owner-configurable % of portfolio NAV ceiling for regular ETFs.
-- Default 30%. Enforced at the execution gateway for BUY orders only (SELL always allowed).
ALTER TABLE strategy_config ADD COLUMN IF NOT EXISTS etf_allocation_cap_pct NUMERIC DEFAULT 30;
