-- P0-2 — one decision, one confidence value.
--
-- DEFECT. `v_decision_quality` recomputed data confidence from a HARDCODED
-- per-market applicability list. For India it declared
-- ['fundamental','technical','sentiment'] applicable, counted the absent
-- sentiment dimension in the denominator, and reported 0.7333 — while the
-- scorer that actually made the decision froze `evidence_confidence = 1.0000`
-- with `included_dims = ['fundamental','technical']`. Every current India
-- observation carried both numbers at once (12/12 sampled). The paper-fill RPC,
-- /api/kite/order, execute-order and Decision Review all read the VIEW, so a
-- money gate and the frozen decision record disagreed about the same decision.
--
-- FIX. The observation is the source of truth: it is the frozen contract the
-- decision was actually made under, and it cannot drift when a market's
-- applicability policy is later edited. The view now SURFACES
-- `decision_observations.evidence_confidence` rather than recomputing a rival
-- number, and keeps the recomputed structural figure beside it under a name
-- that cannot be mistaken for the authoritative one.
--
-- LEGACY ROWS. 210 observations (37 india / 173 us) predate `evidence_confidence`
-- and store NULL. They fall back to the derived value. Without the fallback a
-- usable number would become NULL -> quality_status 'unknown' -> live BUY fails
-- closed, which would silently TIGHTEN a money gate. `confidence_source` makes
-- which rule produced the number explicit per row.
--
-- BEHAVIOUR-PRESERVING. Verified before writing: across all 4,628 joined rows,
-- 0 cross the 0.5 gate in either direction (`would_open_gate` = 0,
-- `would_close_gate` = 0). 837 rows change VALUE; none change any gate outcome.
-- This migration resolves a contradiction; it does not re-decide anything.
--
-- Additive replacement: every pre-existing column keeps its name and type.

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
  FROM decision_observations o
), applic AS (
  SELECT d.*,
    CASE
      WHEN d.market = 'india' THEN ARRAY['fundamental','technical','sentiment']
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
       -- Authoritative: the frozen contract the decision was made under.
       COALESCE(round(stored_confidence, 4), structural_coverage) AS data_confidence,
       -- Diagnostic only. NEVER a gate input; it is the number that disagreed.
       structural_coverage,
       CASE WHEN stored_confidence IS NOT NULL THEN 'observation' ELSE 'derived' END AS confidence_source,
       CASE WHEN COALESCE(round(stored_confidence, 4), structural_coverage) IS NULL
            THEN 'unknown' ELSE 'ok' END AS quality_status,
       CASE
         WHEN COALESCE(round(stored_confidence, 4), structural_coverage) IS NULL THEN NULL::text
         WHEN COALESCE(round(stored_confidence, 4), structural_coverage) >= 0.75 THEN 'high'
         WHEN COALESCE(round(stored_confidence, 4), structural_coverage) >= 0.5  THEN 'med'
         ELSE 'low'
       END AS confidence_band
FROM resolved;

COMMENT ON VIEW public.v_decision_quality IS
  'Decision quality for money gates. data_confidence surfaces the observation''s frozen evidence_confidence (falling back to the derived structural figure for pre-column legacy rows); structural_coverage is diagnostic only and must never gate an order.';

COMMIT;
