-- Historical paper exits prior to the atomic exit RPC wrote pnl_pct but left
-- the duplicate realized_pnl_pct projection null. Both fields have the same
-- percent units; the next migration normalizes compatibility precision.
-- This is idempotent and does not touch positions, cash, prices, or outcomes.

update public.paper_trades
set realized_pnl_pct = pnl_pct
where realized_pnl_pct is null
  and pnl_pct is not null
  and coalesce(exit_at, closed_at) is not null;
