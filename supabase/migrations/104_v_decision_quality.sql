-- Learning-integrity Phase 1 (measure-only): deterministic data-quality view over the
-- append-only decision_observations ledger. Pure function of logged columns
-- (availability_mask + features) — no I/O, covers historical + future rows. Emits a
-- confidence score; it does NOT tag/exclude anything (that is Phase 1B, gated on
-- flag-rate calibration).
--
-- Applied to prod as migrations 104 + 104b (NULL-degraded fix). This file is the
-- consolidated final form.
--
-- data_confidence = Σ base_weights[real dims] / Σ base_weights[structurally applicable dims]
--   applicable dims: india={fundamental,technical,macro}; ETF={technical,sentiment,macro};
--                    US non-ETF={fundamental,technical,sentiment,macro,insider}
--   real = availability_mask[d]=true AND not degraded
--   degraded: macro regime='unknown'; technical dataPoints<15; fundamental note~'no fundamental data'
--   NULL/malformed weights -> data_confidence NULL, quality_status='unknown' (fail-open).

create or replace view v_decision_quality as
with d as (
  select
    o.id as observation_id, o.signal_id, o.market, o.symbol, o.ts,
    o.availability_mask as mask,
    o.features as f,
    o.features->'weighting'->'base_weights' as bw,
    coalesce((o.features->'fundamental'->>'is_etf')::boolean, false) as is_etf
  from decision_observations o
),
applic as (
  select d.*,
    case
      when d.market = 'india' then array['fundamental','technical','macro']
      when d.is_etf then array['technical','sentiment','macro']
      else array['fundamental','technical','sentiment','macro','insider']
    end as applicable_dims
  from d
),
dims as (
  select a.*, dim from applic a, unnest(a.applicable_dims) as dim
),
scored as (
  select observation_id, signal_id, market, symbol, ts, applicable_dims, bw, dim,
    (bw->>dim)::numeric as w,
    coalesce((mask->>dim)::boolean, false) as available,
    coalesce(case dim
      when 'macro' then (f->'macro'->>'regime') = 'unknown'
      when 'technical' then coalesce((f->'technical'->>'dataPoints')::numeric, 0) < 15
      when 'fundamental' then (f->'fundamental'->>'note') ilike '%no fundamental data%'
      else false
    end, false) as degraded
  from dims
),
agg as (
  select observation_id, signal_id, market, symbol, ts, applicable_dims,
    bool_or(w is null) as any_w_null,
    sum(w) as applicable_weight,
    sum(w) filter (where available and not degraded) as available_weight,
    array_agg(dim order by dim) filter (where available and not degraded) as real_dims,
    array_agg(dim order by dim) filter (where not available) as missing_dims,
    array_agg(dim order by dim) filter (where available and degraded) as degraded_dims,
    (array_agg(dim order by w desc nulls last) filter (where available and not degraded))[1] as decisive_dim
  from scored
  group by observation_id, signal_id, market, symbol, ts, applicable_dims
)
select observation_id, signal_id, market, symbol, ts,
  applicable_dims, real_dims, missing_dims, degraded_dims, decisive_dim,
  case when any_w_null or applicable_weight is null or applicable_weight <= 0 then null
       else round(coalesce(available_weight,0) / applicable_weight, 4) end as data_confidence,
  case when any_w_null or applicable_weight is null or applicable_weight <= 0 then 'unknown' else 'ok' end as quality_status,
  case when any_w_null or applicable_weight is null or applicable_weight <= 0 then null
       when coalesce(available_weight,0)/applicable_weight >= 0.75 then 'high'
       when coalesce(available_weight,0)/applicable_weight >= 0.5  then 'med'
       else 'low' end as confidence_band
from agg;
