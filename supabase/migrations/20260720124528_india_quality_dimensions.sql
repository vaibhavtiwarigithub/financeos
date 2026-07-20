-- India applicability correction: this reproduces the hardened view definition
-- and changes India dimensions to fundamental + technical + sentiment. India
-- macro remains structurally inapplicable until a validated India macro model exists.
--
-- Reproducibility fix (Codex review P0-3): migration 112 was comment-only
-- ("applied to prod via MCP") and carried no executable SQL, so a fresh DB
-- rebuild would recreate the OLD (migration 104) v_decision_quality — the one
-- whose unguarded numeric/boolean casts threw on malformed base_weights /
-- availability_mask / technical.dataPoints, breaking the whole view (and
-- health-triage with it). This materializes the CURRENT prod definition with
-- regex-guarded casts (malformed -> NULL -> quality_status='unknown', fail-open)
-- so repo == prod.
--
-- Body is the live prod definition (pg_get_viewdef, 2026-07-08). Idempotent via
-- CREATE OR REPLACE VIEW.

-- 2026-07-20 correction: India runtime scoring uses fundamental, technical,
-- and sentiment. It has no market-tagged macro regime, so macro is structurally
-- inapplicable rather than missing.
CREATE OR REPLACE VIEW public.v_decision_quality AS
 WITH d AS (
         SELECT o.id AS observation_id,
            o.signal_id,
            o.market,
            o.symbol,
            o.ts,
            o.availability_mask AS mask,
            o.features AS f,
            (o.features -> 'weighting'::text) -> 'base_weights'::text AS bw,
            COALESCE(
                CASE
                    WHEN lower((o.features -> 'fundamental'::text) ->> 'is_etf'::text) = ANY (ARRAY['true'::text, 'false'::text]) THEN ((o.features -> 'fundamental'::text) ->> 'is_etf'::text)::boolean
                    ELSE false
                END, false) AS is_etf
           FROM decision_observations o
        ), applic AS (
         SELECT d.observation_id,
            d.signal_id,
            d.market,
            d.symbol,
            d.ts,
            d.mask,
            d.f,
            d.bw,
            d.is_etf,
                CASE
                    WHEN d.market = 'india'::text THEN ARRAY['fundamental'::text, 'technical'::text, 'sentiment'::text]
                    WHEN d.is_etf THEN ARRAY['technical'::text, 'sentiment'::text, 'macro'::text]
                    ELSE ARRAY['fundamental'::text, 'technical'::text, 'sentiment'::text, 'macro'::text, 'insider'::text]
                END AS applicable_dims
           FROM d
        ), dims AS (
         SELECT a.observation_id,
            a.signal_id,
            a.market,
            a.symbol,
            a.ts,
            a.mask,
            a.f,
            a.bw,
            a.is_etf,
            a.applicable_dims,
            dim.dim
           FROM applic a,
            LATERAL unnest(a.applicable_dims) dim(dim)
        ), scored AS (
         SELECT dims.observation_id,
            dims.signal_id,
            dims.market,
            dims.symbol,
            dims.ts,
            dims.applicable_dims,
            dims.bw,
            dims.dim,
                CASE
                    WHEN (dims.bw ->> dims.dim) ~ '^-?[0-9]+(\.[0-9]+)?$'::text THEN (dims.bw ->> dims.dim)::numeric
                    ELSE NULL::numeric
                END AS w,
            COALESCE(
                CASE
                    WHEN lower(dims.mask ->> dims.dim) = ANY (ARRAY['true'::text, 'false'::text]) THEN (dims.mask ->> dims.dim)::boolean
                    ELSE false
                END, false) AS available,
            COALESCE(
                CASE dims.dim
                    WHEN 'macro'::text THEN ((dims.f -> 'macro'::text) ->> 'regime'::text) = 'unknown'::text
                    WHEN 'technical'::text THEN
                    CASE
                        WHEN ((dims.f -> 'technical'::text) ->> 'dataPoints'::text) ~ '^-?[0-9]+(\.[0-9]+)?$'::text THEN ((dims.f -> 'technical'::text) ->> 'dataPoints'::text)::numeric
                        ELSE 0::numeric
                    END < 15::numeric
                    WHEN 'fundamental'::text THEN ((dims.f -> 'fundamental'::text) ->> 'note'::text) ~~* '%no fundamental data%'::text
                    ELSE false
                END, false) AS degraded
           FROM dims
        ), agg AS (
         SELECT scored.observation_id,
            scored.signal_id,
            scored.market,
            scored.symbol,
            scored.ts,
            scored.applicable_dims,
            bool_or(scored.w IS NULL) AS any_w_null,
            sum(scored.w) AS applicable_weight,
            sum(scored.w) FILTER (WHERE scored.available AND NOT scored.degraded) AS available_weight,
            array_agg(scored.dim ORDER BY scored.dim) FILTER (WHERE scored.available AND NOT scored.degraded) AS real_dims,
            array_agg(scored.dim ORDER BY scored.dim) FILTER (WHERE NOT scored.available) AS missing_dims,
            array_agg(scored.dim ORDER BY scored.dim) FILTER (WHERE scored.available AND scored.degraded) AS degraded_dims,
            (array_agg(scored.dim ORDER BY scored.w DESC NULLS LAST) FILTER (WHERE scored.available AND NOT scored.degraded))[1] AS decisive_dim
           FROM scored
          GROUP BY scored.observation_id, scored.signal_id, scored.market, scored.symbol, scored.ts, scored.applicable_dims
        )
 SELECT observation_id,
    signal_id,
    market,
    symbol,
    ts,
    applicable_dims,
    real_dims,
    missing_dims,
    degraded_dims,
    decisive_dim,
        CASE
            WHEN any_w_null OR applicable_weight IS NULL OR applicable_weight <= 0::numeric THEN NULL::numeric
            ELSE round(COALESCE(available_weight, 0::numeric) / applicable_weight, 4)
        END AS data_confidence,
        CASE
            WHEN any_w_null OR applicable_weight IS NULL OR applicable_weight <= 0::numeric THEN 'unknown'::text
            ELSE 'ok'::text
        END AS quality_status,
        CASE
            WHEN any_w_null OR applicable_weight IS NULL OR applicable_weight <= 0::numeric THEN NULL::text
            WHEN (COALESCE(available_weight, 0::numeric) / applicable_weight) >= 0.75 THEN 'high'::text
            WHEN (COALESCE(available_weight, 0::numeric) / applicable_weight) >= 0.5 THEN 'med'::text
            ELSE 'low'::text
        END AS confidence_band
   FROM agg;

-- Views otherwise execute with creator privileges. Preserve the owner's RLS
-- boundary explicitly even on a fresh replay of this late replacement.
ALTER VIEW public.v_decision_quality SET (security_invoker = true);
