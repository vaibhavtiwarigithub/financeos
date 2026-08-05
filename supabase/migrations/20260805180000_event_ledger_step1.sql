-- Event ledger step 1 — append-only market events + matured forward outcomes.
--
-- Purpose: turn recurring event patterns (the motivating one being an aggressive
-- policy announcement that the actor has historically reversed) into a COUNTED
-- base rate instead of a remembered story. Nothing in the schema could record a
-- dated, typed market event before this.
--
-- MEASUREMENT ONLY. No score, eligibility, sizing, entry, exit, promotion or
-- broker path reads either table. An event is market-wide, so its per-date
-- cross-sectional variance within the affected set is zero by construction —
-- the defect that disqualified NSE FII/DII in R3_DIMENSION_FEASIBILITY.md.
-- See features/event-ledger/FEATURE_ARCHITECTURE.md.
--
-- Additive and idempotent.

CREATE TABLE IF NOT EXISTS public.market_events (
  id           bigserial PRIMARY KEY,
  -- Controlled vocabulary, enforced in lib/events/vocabulary.ts. Not a DB enum:
  -- extending an enum is a migration, and the vocabulary is meant to be
  -- owner-reviewed rather than casually widened. The API validates on write.
  event_type   text        NOT NULL,
  -- When the event became PUBLIC. The single field the whole ledger rests on:
  -- if this drifts toward "when we noticed", every backward measurement is
  -- contaminated by look-ahead and the base rate is silently optimistic.
  occurred_at  timestamptz NOT NULL,
  -- When WE recorded it. Kept separate from occurred_at on purpose.
  observed_at  timestamptz NOT NULL DEFAULT now(),
  market       text        NOT NULL CHECK (market IN ('us', 'india', 'global')),
  direction    text        NOT NULL CHECK (direction IN ('escalation', 'de_escalation', 'neutral')),
  -- Type-specific; the unit is documented per type in the vocabulary so values
  -- stay comparable within a type. Nullable because not every event has one.
  magnitude    numeric,
  source_url   text        NOT NULL,
  source_name  text        NOT NULL,
  notes        text,
  -- An event recorded before it happened is a data error, not a valid row.
  CONSTRAINT market_events_occurred_before_observed CHECK (occurred_at <= observed_at),
  -- Same (type, market, instant) twice is a duplicate entry, not two events.
  UNIQUE (event_type, market, occurred_at)
);

COMMENT ON TABLE public.market_events IS
  'Append-only ledger of dated, typed market events. Measurement only: no score, eligibility, sizing, exit or broker consumer.';
COMMENT ON COLUMN public.market_events.occurred_at IS
  'When the event became PUBLIC. Must not postdate observed_at. Look-ahead enters here.';

CREATE INDEX IF NOT EXISTS market_events_type_time_idx
  ON public.market_events (event_type, occurred_at DESC);

-- Matured forward paths, mirroring observation_labels so the maturation job and
-- the statistics are the same shape rather than a second implementation.
CREATE TABLE IF NOT EXISTS public.market_event_outcomes (
  id                        bigserial PRIMARY KEY,
  event_id                  bigint      NOT NULL REFERENCES public.market_events(id) ON DELETE CASCADE,
  horizon_days              int         NOT NULL CHECK (horizon_days > 0),
  benchmark_symbol          text        NOT NULL,
  fwd_return                numeric,
  benchmark_return          numeric,
  benchmark_neutral_return  numeric,
  max_adverse_excursion     numeric,
  max_favorable_excursion   numeric,
  matured_at                timestamptz NOT NULL DEFAULT now(),
  UNIQUE (event_id, horizon_days, benchmark_symbol)
);

COMMENT ON TABLE public.market_event_outcomes IS
  'Matured forward paths per (event, horizon). Mirrors observation_labels. Measurement only.';

CREATE INDEX IF NOT EXISTS market_event_outcomes_event_idx
  ON public.market_event_outcomes (event_id, horizon_days);

ALTER TABLE public.market_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.market_event_outcomes ENABLE ROW LEVEL SECURITY;

-- RLS filters rows but grants no table privilege, so these grants are what make
-- owner reads work (the pattern corrected in 20260801150500).
REVOKE ALL ON public.market_events FROM anon, authenticated;
REVOKE ALL ON public.market_event_outcomes FROM anon, authenticated;
GRANT SELECT ON public.market_events TO authenticated;
GRANT SELECT ON public.market_event_outcomes TO authenticated;

DROP POLICY IF EXISTS market_events_owner_read ON public.market_events;
CREATE POLICY market_events_owner_read ON public.market_events
  FOR SELECT TO authenticated
  USING ((select auth.jwt() ->> 'email') = 'vterminater@gmail.com');

DROP POLICY IF EXISTS market_events_service_all ON public.market_events;
CREATE POLICY market_events_service_all ON public.market_events
  FOR ALL TO service_role USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS market_event_outcomes_owner_read ON public.market_event_outcomes;
CREATE POLICY market_event_outcomes_owner_read ON public.market_event_outcomes
  FOR SELECT TO authenticated
  USING ((select auth.jwt() ->> 'email') = 'vterminater@gmail.com');

DROP POLICY IF EXISTS market_event_outcomes_service_all ON public.market_event_outcomes;
CREATE POLICY market_event_outcomes_service_all ON public.market_event_outcomes
  FOR ALL TO service_role USING (true) WITH CHECK (true);

-- Append-only as a grant property, not a writer convention. The events table
-- never needs UPDATE; outcomes keep UPDATE so a horizon can be re-matured if the
-- price source is corrected, but never DELETE or TRUNCATE.
REVOKE UPDATE, DELETE, TRUNCATE ON public.market_events FROM service_role;
REVOKE DELETE, TRUNCATE ON public.market_event_outcomes FROM service_role;
