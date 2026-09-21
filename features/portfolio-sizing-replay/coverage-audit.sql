-- READ ONLY sizing-replay coverage audit. Freeze the cutoff before interpreting it.
with risk_plans as (
  select distinct on (t.id) t.id, t.market, t.symbol, t.executed_at,
    coalesce(t.exit_at, t.closed_at, timestamptz '2026-09-19 00:00:00+00') as end_at
  from paper_trades t join pipeline_stage_events s on s.signal_id=t.signal_id
    and s.market=t.market and s.symbol=t.symbol and s.stage='risk_plan' and s.outcome='passed'
    and jsonb_typeof(s.detail->'stop_loss')='number' and jsonb_typeof(s.detail->'fill_price')='number'
    -- CASE keeps this read-only audit safe if malformed JSON is present; do not
    -- rely on PostgreSQL evaluating the JSON type predicate before a cast.
    and case when jsonb_typeof(s.detail->'stop_loss')='number'
      then (s.detail->>'stop_loss')::numeric > 0 and (s.detail->>'stop_loss')::numeric < t.fill_price else false end
    and case when jsonb_typeof(s.detail->'fill_price')='number'
      then abs((s.detail->>'fill_price')::numeric - t.fill_price) <= 0.0001 else false end
    and s.created_at <= t.executed_at and s.created_at >= t.executed_at - interval '10 minutes'
  where t.order_side='buy' and t.market in ('us','india')
    and t.executed_at < timestamptz '2026-09-19 00:00:00+00'
  order by t.id, s.created_at desc, s.id desc
), bars as (
  select r.id, count(p.date) as bar_count from risk_plans r left join price_cache p
    on upper(regexp_replace(p.symbol,'\\.(NS|BO)$','')) = upper(regexp_replace(r.symbol,'\\.(NS|BO)$',''))
   and p.date::date between r.executed_at::date and r.end_at::date
  group by r.id
), india_symbols as (
  select distinct upper(regexp_replace(t.symbol,'\\.(NS|BO)$','')) as root
  from paper_trades t where t.market='india' and t.order_side='buy'
), india_price_roots as (
  select distinct upper(regexp_replace(p.symbol,'\\.(NS|BO)$','')) as root
  from price_cache p
), missing_india as (
  select coalesce(jsonb_agg(i.root order by i.root),'[]'::jsonb) as symbols
  from india_symbols i left join india_price_roots p using(root)
  where p.root is null
)
select jsonb_build_object(
  'price_cache', (select jsonb_build_object('rows',count(*),'min',min(date),'max',max(date),'symbols',count(distinct symbol)) from price_cache),
  'risk_stop_matches', count(*), 'risk_stop_matches_with_price_bars', count(*) filter (where b.bar_count > 0),
  'us_stop_matches', count(*) filter (where r.market='us'), 'india_stop_matches', count(*) filter (where r.market='india'),
  'india_buy_symbol_roots_without_any_price_cache', (select symbols from missing_india),
  'cutoff', '2026-09-19T00:00:00Z')
from risk_plans r join bars b on b.id=r.id;
