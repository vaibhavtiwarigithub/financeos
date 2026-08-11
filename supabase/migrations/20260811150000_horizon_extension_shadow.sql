-- Conditional horizon-extension shadow ledger.
--
-- Append-only record of what the extension policy WOULD have decided for each
-- open position, evaluated daily. Nothing reads this to make a decision; it
-- exists to accumulate the forward evidence that section 7's activation floor
-- requires before any exit rule may change.
--
-- Append-only is enforced the same way the other evidence ledgers are: writes
-- are service-role only, and UPDATE/DELETE are blocked by trigger so a later
-- run cannot rewrite what an earlier run observed.

BEGIN;

CREATE TABLE IF NOT EXISTS public.horizon_extension_shadow (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id              text        NOT NULL,
  evaluated_at        timestamptz NOT NULL DEFAULT now(),
  market              text        NOT NULL CHECK (market IN ('us','india')),
  symbol              text        NOT NULL,
  position_id         text        NOT NULL,

  age_days            integer     NOT NULL,
  horizon_days        integer     NOT NULL,
  ceiling_days        integer     NOT NULL,
  effective_exit_day  integer     NOT NULL,

  would_extend        boolean     NOT NULL,
  reason              text        NOT NULL,
  failed              jsonb,

  score               numeric,
  score_fresh         boolean,
  prior_score         numeric,
  entry_threshold     numeric,
  unrealized_pct      numeric,
  benchmark_rel_pct   numeric,
  price_above_ema20   boolean,
  breakdown_veto      boolean,
  earnings_veto       boolean,
  data_quality_ok     boolean,

  -- The policy is additive-only and bounded by the mandate ceiling. Pin that in
  -- the schema so no future writer can persist a row claiming an extension past
  -- the ceiling, even if the application logic regresses.
  CONSTRAINT horizon_extension_age_nonnegative CHECK (age_days >= 0),
  CONSTRAINT horizon_extension_horizon_positive CHECK (horizon_days >= 1),
  CONSTRAINT horizon_extension_ceiling_valid CHECK (ceiling_days >= horizon_days),
  CONSTRAINT horizon_extension_within_ceiling CHECK (effective_exit_day <= ceiling_days),
  -- effective_exit_day is the policy's effective horizon boundary. It may be
  -- behind age_days for an already-overdue position, but it may never shorten
  -- the position's original horizon.
  CONSTRAINT horizon_extension_never_shortens CHECK (effective_exit_day >= horizon_days)
);

CREATE INDEX IF NOT EXISTS horizon_extension_shadow_run_idx
  ON horizon_extension_shadow (run_id);
CREATE INDEX IF NOT EXISTS horizon_extension_shadow_market_date_idx
  ON horizon_extension_shadow (market, evaluated_at DESC);
CREATE INDEX IF NOT EXISTS horizon_extension_shadow_symbol_idx
  ON horizon_extension_shadow (symbol, evaluated_at DESC);

ALTER TABLE public.horizon_extension_shadow ENABLE ROW LEVEL SECURITY;

-- Owner may read; nobody may write through PostgREST. Writes come from the
-- service role, which bypasses RLS.
DROP POLICY IF EXISTS horizon_extension_shadow_owner_read ON public.horizon_extension_shadow;
CREATE POLICY horizon_extension_shadow_owner_read
  ON public.horizon_extension_shadow FOR SELECT
  TO authenticated
  USING (((select auth.jwt()) ->> 'email') = 'vterminater@gmail.com');

-- Supabase projects commonly grant new public tables through default
-- privileges. Revoke explicitly before granting the narrow intended surface.
REVOKE ALL ON public.horizon_extension_shadow FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.horizon_extension_shadow TO authenticated;
GRANT SELECT, INSERT ON public.horizon_extension_shadow TO service_role;

-- Append-only: block mutation of an observation after the fact.
CREATE OR REPLACE FUNCTION horizon_extension_shadow_no_mutate()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  RAISE EXCEPTION 'horizon_extension_shadow is append-only';
END;
$$;

DROP TRIGGER IF EXISTS horizon_extension_shadow_no_update ON horizon_extension_shadow;
CREATE TRIGGER horizon_extension_shadow_no_update
  BEFORE UPDATE OR DELETE ON public.horizon_extension_shadow
  FOR EACH ROW EXECUTE FUNCTION horizon_extension_shadow_no_mutate();

COMMIT;
