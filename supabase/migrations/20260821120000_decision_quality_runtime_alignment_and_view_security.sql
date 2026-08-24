-- Align the read-model with the frozen decision contract and re-assert caller
-- RLS after every CREATE OR REPLACE VIEW replacement.
--
-- India ResearchAgent declares only fundamental + technical structurally
-- applicable (lib/research-agent.ts: applicableDimensions). The prior view
-- added sentiment, producing an independent confidence calculation that could
-- disagree with the value frozen on decision_observations. This migration keeps
-- the immutable observation's evidence_confidence authoritative, corrects the
-- legacy fallback denominator, and explicitly restores security_invoker.

BEGIN;

CREATE OR REPLACE VIEW public.v_decision_quality AS
WITH d AS (
  SELECT o.id AS observation_id, o.signal_id, o.market, o.symbol, o.ts,
         o.availability_mask AS mask, o.features AS f,
         (o.features -> 'weighting') -> 'base_weights' AS bw,
         o.evidence_confidence AS stored_confidence,
         COALESCE(CASE
           WHEN lower((o.features -> 'fundamental') ->> 'is_etf') = ANY (ARRAY['true','false'])
             THEN ((o.features -> 'fundamental') ->> 'is_etf')::boolean
           ELSE false END, false) AS is_etf
  FROM public.decision_observations o
), applic AS (
  SELECT d.*,
    CASE
      WHEN d.market = 'india' THEN ARRAY['fundamental','technical']
      WHEN d.is_etf THEN ARRAY['technical','sentiment','macro']
      ELSE ARRAY['fundamental','technical','sentiment','macro','insider']
    END AS applicable_dims
  FROM d
), dims AS (
  SELECT a.*, dim.dim FROM applic a, LATERAL unnest(a.applicable_dims) dim(dim)
), scored AS (
  SELECT dims.observation_id, dims.signal_id, dims.market, dims.symbol, dims.ts,
         dims.applicable_dims, dims.bw, dims.dim, dims.stored_confidence,
    CASE WHEN (dims.bw ->> dims.dim) ~ '^-?[0-9]+(\.[0-9]+)?$'
         THEN (dims.bw ->> dims.dim)::numeric ELSE NULL::numeric END AS w,
    COALESCE(CASE
      WHEN lower(dims.mask ->> dims.dim) = ANY (ARRAY['true','false'])
        THEN (dims.mask ->> dims.dim)::boolean ELSE false END, false) AS available,
    COALESCE(CASE dims.dim
      WHEN 'macro' THEN ((dims.f -> 'macro') ->> 'regime') = 'unknown'
      WHEN 'technical' THEN
        CASE WHEN ((dims.f -> 'technical') ->> 'dataPoints') ~ '^-?[0-9]+(\.[0-9]+)?$'
             THEN ((dims.f -> 'technical') ->> 'dataPoints')::numeric
             ELSE 0::numeric END < 15::numeric
      WHEN 'fundamental' THEN ((dims.f -> 'fundamental') ->> 'note') ~~* '%no fundamental data%'
      ELSE false END, false) AS degraded
  FROM dims
), agg AS (
  SELECT observation_id, signal_id, market, symbol, ts, applicable_dims,
         min(stored_confidence) AS stored_confidence,
         bool_or(w IS NULL) AS any_w_null,
         sum(w) AS applicable_weight,
         sum(w) FILTER (WHERE available AND NOT degraded) AS available_weight,
         array_agg(dim ORDER BY dim) FILTER (WHERE available AND NOT degraded) AS real_dims,
         array_agg(dim ORDER BY dim) FILTER (WHERE NOT available) AS missing_dims,
         array_agg(dim ORDER BY dim) FILTER (WHERE available AND degraded) AS degraded_dims,
         (array_agg(dim ORDER BY w DESC NULLS LAST) FILTER (WHERE available AND NOT degraded))[1] AS decisive_dim
  FROM scored
  GROUP BY observation_id, signal_id, market, symbol, ts, applicable_dims
), resolved AS (
  SELECT agg.*,
    CASE WHEN any_w_null OR applicable_weight IS NULL OR applicable_weight <= 0 THEN NULL::numeric
         ELSE round(COALESCE(available_weight, 0::numeric) / applicable_weight, 4)
    END AS structural_coverage
  FROM agg
)
SELECT observation_id, signal_id, market, symbol, ts,
       applicable_dims, real_dims, missing_dims, degraded_dims, decisive_dim,
       COALESCE(round(stored_confidence, 4), structural_coverage) AS data_confidence,
       CASE WHEN COALESCE(round(stored_confidence, 4), structural_coverage) IS NULL
            THEN 'unknown' ELSE 'ok' END AS quality_status,
       CASE
         WHEN COALESCE(round(stored_confidence, 4), structural_coverage) IS NULL THEN NULL::text
         WHEN COALESCE(round(stored_confidence, 4), structural_coverage) >= 0.75 THEN 'high'
         WHEN COALESCE(round(stored_confidence, 4), structural_coverage) >= 0.5 THEN 'med'
         ELSE 'low'
       END AS confidence_band,
       structural_coverage,
       CASE WHEN stored_confidence IS NOT NULL THEN 'observation' ELSE 'derived' END AS confidence_source
FROM resolved;

ALTER VIEW public.v_decision_quality SET (security_invoker = true);

COMMENT ON VIEW public.v_decision_quality IS
  'Decision quality for money gates. data_confidence surfaces the immutable observation evidence_confidence, with a structurally applicable fallback only for legacy rows. The view evaluates RLS as its caller.';

COMMIT;
