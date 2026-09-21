-- READ ONLY. Frozen audit cutoff; these are candidate matches, not replay approval.
-- Preserve source IDs and timestamps. Never UPDATE historical stops from this query.
-- Partial-lot lineage, taint exclusions, sector and marks require separate review.
with risk_plans as (
  select id, signal_id, market, symbol, created_at,
    case when jsonb_typeof(detail->'stop_loss') = 'number'
      then (detail->>'stop_loss')::numeric end as original_stop,
    case when jsonb_typeof(detail->'fill_price') = 'number'
      then (detail->>'fill_price')::numeric end as planned_fill
  from pipeline_stage_events
  where stage = 'risk_plan' and outcome = 'passed'
    and created_at < timestamptz '2026-09-19 00:00:00+00'
)
select t.id as lot_id, t.market, t.symbol, t.signal_id, t.executed_at,
  t.fill_price, t.stop_loss as captured_lot_stop,
  s.id as risk_plan_event_id, s.created_at as stop_observed_at,
  s.original_stop, s.planned_fill,
  case when s.id is null then 'missing_original_stop_evidence'
    else 'candidate_match_requires_lineage_and_taint_review' end as evidence_status
from paper_trades t
left join lateral (
  select s.* from risk_plans s
  where s.signal_id = t.signal_id and s.market = t.market and s.symbol = t.symbol
    and s.original_stop > 0 and s.original_stop < t.fill_price
    and abs(s.planned_fill - t.fill_price) <= 0.0001
    and s.created_at <= t.executed_at
    and s.created_at >= t.executed_at - interval '10 minutes'
  order by s.created_at desc, s.id desc limit 1
) s on true
where t.market in ('us', 'india')
  and t.executed_at < timestamptz '2026-09-19 00:00:00+00'
order by t.market, t.executed_at, t.id;
