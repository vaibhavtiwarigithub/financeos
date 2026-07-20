-- Repair derived paper-performance fields and make every historical row agree
-- with the canonical per-market seed. NAV/cash/position values are source facts;
-- this migration only recomputes their derived presentation/analytics fields.

with ordered as (
  select
    id,
    nav,
    market,
    lag(nav) over (partition by market order by date) as previous_nav
  from public.paper_performance
),
truth as (
  select
    p.id,
    p.nav - case when p.market = 'india' then 1000000::numeric else 10000::numeric end as total_pnl,
    ((p.nav - case when p.market = 'india' then 1000000::numeric else 10000::numeric end)
      / case when p.market = 'india' then 1000000::numeric else 10000::numeric end) * 100 as total_pnl_pct,
    case when o.previous_nav is null then 0::numeric else p.nav - o.previous_nav end as daily_pnl,
    (select count(*) from public.paper_trades t
      where t.market = p.market and t.closed_at::date <= p.date and t.outcome = 'win') as win_count,
    (select count(*) from public.paper_trades t
      where t.market = p.market and t.closed_at::date <= p.date and t.outcome = 'loss') as loss_count,
    (select count(*) from public.paper_trades t
      where t.market = p.market and t.closed_at::date <= p.date and t.outcome is not null) as resolved_count
  from public.paper_performance p
  join ordered o on o.id = p.id
)
update public.paper_performance p
set
  daily_pnl = t.daily_pnl,
  total_pnl = t.total_pnl,
  total_pnl_pct = t.total_pnl_pct,
  win_count = t.win_count,
  loss_count = t.loss_count,
  win_rate = case when t.resolved_count > 0 then t.win_count::numeric / t.resolved_count else 0 end,
  alpha_pct = case when p.bench_return_pct is null then null else t.total_pnl_pct - p.bench_return_pct end,
  updated_at = now()
from truth t
where p.id = t.id;

comment on column public.paper_performance.total_pnl is
  'NAV minus the fixed seed for this row market (US 10000 USD; India 1000000 INR).';
comment on column public.paper_performance.total_pnl_pct is
  'Cumulative paper-book return from the fixed per-market seed, in percentage points.';
comment on column public.paper_performance.daily_pnl is
  'NAV change from the prior recorded row in the same market; zero on the first row.';
comment on column public.paper_performance.win_rate is
  'Cumulative wins divided by all resolved outcomes (including breakeven) for this market as of row date; fraction 0..1.';
