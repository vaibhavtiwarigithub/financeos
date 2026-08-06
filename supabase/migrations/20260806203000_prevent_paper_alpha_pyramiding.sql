-- Paper alpha entries are one-shot. A newly scored open holding may be
-- reassessed by ResearchAgent/PositionMonitor, but cannot receive a second buy
-- until an explicitly validated, separately governed add-to-winner policy
-- exists. This is enforced below the route so concurrent calls cannot bypass it.
--
-- The historic duplicate below is a corrupt projection: two buy rows share one
-- immutable paper_order_event while the position and event ledger each record
-- one fill. It has no learner or memory reference, so retaining it would double
-- count a non-existent trade in performance/learning views.

with ranked_duplicate_projection as (
  select
    id,
    row_number() over (partition by paper_event_id order by executed_at, id) as row_number
  from public.paper_trades
  where order_side = 'buy' and paper_event_id is not null
)
delete from public.paper_trades trade
using ranked_duplicate_projection duplicate
where trade.id = duplicate.id
  and duplicate.row_number > 1
  and not exists (select 1 from public.learning_log log where log.trade_id = trade.id)
  and not exists (select 1 from public.trade_memories memory where memory.trade_id = trade.id);

do $$
begin
  if exists (
    select 1
    from public.paper_trades
    where order_side = 'buy' and paper_event_id is not null
    group by paper_event_id
    having count(*) > 1
  ) then
    raise exception 'cannot enforce paper fill uniqueness while duplicate buy projections remain';
  end if;
  if exists (
    select 1
    from public.paper_trades
    where order_side = 'buy' and signal_id is not null
    group by market, signal_id
    having count(*) > 1
  ) then
    raise exception 'cannot enforce paper signal uniqueness while duplicate buy signals remain';
  end if;
end;
$$;

create unique index if not exists paper_trades_buy_event_unique
  on public.paper_trades (paper_event_id)
  where order_side = 'buy' and paper_event_id is not null;

create unique index if not exists paper_trades_buy_signal_unique
  on public.paper_trades (market, signal_id)
  where order_side = 'buy' and signal_id is not null;

create unique index if not exists paper_order_events_buy_signal_unique
  on public.paper_order_events (market, signal_id)
  where event_type = 'fill' and side = 'buy' and signal_id is not null;

create or replace function public.prevent_paper_alpha_pyramid()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if new.order_side = 'buy'
     and coalesce(new.position_role, 'alpha') = 'alpha'
     and exists (
       select 1
       from public.paper_positions position
       where position.market = new.market
         and upper(position.symbol) = upper(new.symbol)
         and coalesce(position.position_role, 'alpha') = 'alpha'
     ) then
    raise exception using
      errcode = 'P0001',
      message = 'existing_open_position';
  end if;
  return new;
end;
$$;

revoke all on function public.prevent_paper_alpha_pyramid() from public;

drop trigger if exists paper_trades_prevent_alpha_pyramid on public.paper_trades;
create trigger paper_trades_prevent_alpha_pyramid
  before insert on public.paper_trades
  for each row execute function public.prevent_paper_alpha_pyramid();
