-- Root cause of the 2026-10-13 `paper-nav-reconcile:us` critical alert (cash_ledger_identity drift $15.46 > tol $10.16).
--
-- execute_paper_exit closes lots oldest-first (FIFO) on a partial exit and shrinks paper_positions.qty, but never recomputed
-- paper_positions.avg_cost. When the closed lots had a different cost than the surviving ones, the position row kept the OLD blended
-- average, so qty x avg_cost no longer equalled the surviving lots' cost. Cash, realized P&L and lot rows were all correct (proceeds
-- 2016.09 matched the cash credit exactly); only the position cost basis was stale. AAPL (-15.06) and PLTR (-0.40) were affected.
--
-- 1) Patch the function in place: after the lots are closed/split, set avg_cost from the surviving open lots.
-- 2) One-off repair of existing rows to the same definition (cost-weighted average of open lots). Idempotent.

do $$
declare
  v_def text;
  v_old text := E'      qty = v_remaining,\n      current_price = p_exit_price,';
  v_new text := E'      qty = v_remaining,\n      avg_cost = coalesce((\n        select sum(t.qty * t.fill_price) / nullif(sum(t.qty), 0)\n        from public.paper_trades t\n        where t.symbol = v_pos.symbol and t.market = v_pos.market and t.closed_at is null\n          and t.position_role = v_pos.position_role and t.order_side = ''buy''\n      ), avg_cost),\n      current_price = p_exit_price,';
begin
  select pg_get_functiondef('public.execute_paper_exit(uuid,numeric,text,numeric,numeric)'::regprocedure) into v_def;
  if position(v_old in v_def) = 0 then
    if position('avg_cost = coalesce((' in v_def) > 0 then return; end if; -- already patched
    raise exception 'execute_paper_exit partial-exit update block not found; refusing to patch blindly';
  end if;
  execute replace(v_def, v_old, v_new);
end $$;

update public.paper_positions p
set avg_cost = l.avg_fill, updated_at = now()
from (
  select market, symbol, position_role, sum(qty * fill_price) / nullif(sum(qty), 0) as avg_fill, sum(qty) as lot_qty
  from public.paper_trades
  where closed_at is null and order_side = 'buy'
  group by market, symbol, position_role
) l
where p.market = l.market and p.symbol = l.symbol and p.position_role = l.position_role
  and p.qty > 0 and abs(p.qty - l.lot_qty) < 0.000001
  and abs(p.qty * p.avg_cost - p.qty * l.avg_fill) > 0.01;
