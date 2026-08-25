-- Admit the long evaluation horizons (h60 ≈ 3M, h120 ≈ 6M) into the dimension
-- diagnostics table.
--
-- `label-maturation` has been writing observation_labels at 60 and 120 since
-- 2026-08-17 (HORIZONS = [2,5,10,20,60,120]), but dimension_diagnostic_runs
-- still constrained horizon_days to the short set. Widening DIAGNOSTIC_HORIZONS
-- in code without this migration would make every h60/h120 insert throw — and
-- because runMarket() rethrows on insert failure, that would kill diagnostics
-- for ALL horizons, not just the new ones.
--
-- These horizons answer "are we exiting too early", which the <=20d labels
-- structurally cannot: the mandate holds 5-15 sessions, so a 20-day label can
-- never observe what the position would have done afterwards.

BEGIN;

ALTER TABLE public.dimension_diagnostic_runs
  DROP CONSTRAINT IF EXISTS dimension_diagnostic_runs_horizon_days_check;

ALTER TABLE public.dimension_diagnostic_runs
  ADD CONSTRAINT dimension_diagnostic_runs_horizon_days_check
  CHECK (horizon_days = ANY (ARRAY[2, 5, 10, 20, 60, 120]));

COMMENT ON COLUMN public.dimension_diagnostic_runs.horizon_days IS
  'Trading-day evaluation horizon. 2/5/10/20 rank signal quality at or near the mandate holding period; 60/120 measure exit timing and are DECOUPLED from how long a position is actually held. Long-horizon findings carry far fewer independent observations than their date count suggests — see the nEffective correction in lib/learning/dimension-diagnostics.ts.';

COMMIT;
