-- Theme tracking step 1 — stable identity + an append-only observation ledger.
--
-- watchlist.theme has been populated since 2026-06-30 (182 rows, 13 runs, zero
-- nulls), but the name is free text minted fresh by an LLM each run: 42 distinct
-- strings, 32 appearing exactly once, and "Cybersecurity" arriving as six
-- separate strings over five weeks. No rise/decline signal is computable from
-- that. theme_slug supplies the identity; theme_observations supplies the
-- history, which watchlist cannot because its rows expire after 7 days.
--
-- MEASUREMENT ONLY. Nothing here is read by a score, eligibility, sizing,
-- entry, exit, promotion, or broker path. See
-- features/theme-tracking/FEATURE_ARCHITECTURE.md.
--
-- Additive and idempotent. No existing column or row is modified by this file;
-- the backfill of theme_slug runs separately through the shared resolver so the
-- vocabulary has exactly one implementation.

ALTER TABLE public.watchlist
  ADD COLUMN IF NOT EXISTS theme_slug text;

COMMENT ON COLUMN public.watchlist.theme_slug IS
  'Stable theme identity from lib/themes/vocabulary.ts. NULL = raw theme not covered by the controlled vocabulary (deliberate; not backfilled by guesswork).';

CREATE INDEX IF NOT EXISTS watchlist_theme_slug_idx
  ON public.watchlist (theme_slug) WHERE theme_slug IS NOT NULL;

-- One row per (run, theme). Append-only: a theme's recurrence across runs IS the
-- signal, so history must survive the 7-day watchlist expiry.
CREATE TABLE IF NOT EXISTS public.theme_observations (
  id            bigserial PRIMARY KEY,
  observed_at   timestamptz NOT NULL DEFAULT now(),
  run_date      date        NOT NULL,
  market        text        NOT NULL CHECK (market IN ('us', 'india')),
  -- NULL slug records an unmatched theme rather than dropping it. The unmatched
  -- rate is the metric that says when the vocabulary needs extending.
  theme_slug    text,
  theme_raw     text        NOT NULL,
  symbols       text[]      NOT NULL DEFAULT '{}',
  member_count  int         NOT NULL DEFAULT 0,
  UNIQUE (run_date, market, theme_raw)
);

COMMENT ON TABLE public.theme_observations IS
  'Append-only per-run record of Theme Scout output. Measurement only: no score, eligibility, sizing, exit or broker consumer.';

CREATE INDEX IF NOT EXISTS theme_observations_slug_date_idx
  ON public.theme_observations (theme_slug, run_date DESC);

ALTER TABLE public.theme_observations ENABLE ROW LEVEL SECURITY;

-- RLS filters rows but grants no table privilege, so the grants below are what
-- actually make owner reads work (the pattern corrected in 20260801150500).
REVOKE ALL ON public.theme_observations FROM anon, authenticated;
GRANT SELECT ON public.theme_observations TO authenticated;

DROP POLICY IF EXISTS theme_observations_owner_read ON public.theme_observations;
CREATE POLICY theme_observations_owner_read ON public.theme_observations
  FOR SELECT TO authenticated
  USING ((select auth.jwt() ->> 'email') = 'vterminater@gmail.com');

DROP POLICY IF EXISTS theme_observations_service_all ON public.theme_observations;
CREATE POLICY theme_observations_service_all ON public.theme_observations
  FOR ALL TO service_role USING (true) WITH CHECK (true);

-- The writer only ever INSERTs. Append-only is a property of the ledger, not a
-- convention the writer happens to follow.
REVOKE UPDATE, DELETE, TRUNCATE ON public.theme_observations FROM service_role;
