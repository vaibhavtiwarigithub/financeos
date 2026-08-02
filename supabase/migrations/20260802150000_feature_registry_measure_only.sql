-- Feature-registry formulas are observational evidence, never automatic score inputs.
-- Legacy `active` rows were already read only for logging; rename them to make that
-- boundary explicit without changing any score, signal, paper, live, or broker path.

ALTER TABLE public.feature_registry
  DROP CONSTRAINT IF EXISTS feature_registry_status_check;

UPDATE public.feature_registry
SET status = 'measure_only', updated_at = now()
WHERE status = 'active';

ALTER TABLE public.feature_registry
  ADD CONSTRAINT feature_registry_status_check
  CHECK (status IN ('proposed', 'quarantined', 'measure_only', 'retired'));

COMMENT ON COLUMN public.feature_registry.status IS
  'Lifecycle for observational formulas only. measure_only is not score, eligibility, sizing, paper, live, exit, or broker permission.';
