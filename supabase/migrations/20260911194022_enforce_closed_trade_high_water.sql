-- Defense in depth for closed-lot high-water capture.
--
-- Migration 20260911153405 patched the current execute_paper_exit source. A
-- source-text rewrite is brittle and its early idempotency check could accept a
-- partially patched function. This trigger establishes the invariant at the
-- table boundary: whenever an open lot becomes closed, copy the best verified
-- high-water value while paper_positions still exists in the transaction.

create or replace function public.capture_paper_trade_high_water()
returns trigger
language plpgsql
set search_path = pg_catalog, public
as $fn$
declare
  v_position_high numeric;
begin
  if old.closed_at is null and new.closed_at is not null then
    select max(p.highest_price)
      into v_position_high
      from public.paper_positions p
      where p.symbol = new.symbol
        and p.market = new.market
        and p.position_role = new.position_role;

    new.highest_price := greatest(
      coalesce(new.highest_price, v_position_high, new.exit_price, new.fill_price),
      coalesce(v_position_high, new.exit_price, new.fill_price),
      coalesce(new.exit_price, new.fill_price)
    );
  end if;
  return new;
end;
$fn$;

revoke all on function public.capture_paper_trade_high_water() from public, anon, authenticated;

drop trigger if exists paper_trades_capture_high_water on public.paper_trades;
create trigger paper_trades_capture_high_water
before update of closed_at on public.paper_trades
for each row
when (old.closed_at is null and new.closed_at is not null)
execute function public.capture_paper_trade_high_water();

comment on function public.capture_paper_trade_high_water() is
  'Ensures every newly closed paper lot captures the verified open-position high-water before that position is deleted.';
