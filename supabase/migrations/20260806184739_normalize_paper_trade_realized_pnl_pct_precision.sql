-- The initial production backfill used the canonical value without the
-- four-decimal compatibility precision used by execute_paper_exit. Normalize
-- only closed rows with a known canonical return. Idempotent by predicate.

update public.paper_trades
set realized_pnl_pct = round(pnl_pct, 4)
where pnl_pct is not null
  and coalesce(exit_at, closed_at) is not null
  and realized_pnl_pct is distinct from round(pnl_pct, 4);
