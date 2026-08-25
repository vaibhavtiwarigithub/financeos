-- Setup-expert comparison could only ever record ONE expert per observation.
--
-- DEFECT. `163_shadow_decision_idempotency.sql` created:
--   shadow_decisions_observation_policy_uidx
--     ON (observation_id, policy_version_id) NULLS NOT DISTINCT
--     WHERE observation_id IS NOT NULL
--
-- Baseline (non-challenger) expert rows carry `policy_version_id IS NULL`, and
-- NULLS NOT DISTINCT makes every such row collide on (observation_id, NULL).
-- So a batch writing N experts for one observation keeps the first and conflicts
-- on the rest.
--
-- Measured 2026-08-24: US holds 1,604 rows across exactly two setup types, and
-- every observation_id appears EXACTLY ONCE (1,140 obs / 1,140 etf_trend rows;
-- 464 / 464 quality_momentum) — the comparison it exists to make was never
-- recorded. India writes two experts on every observation, so every batch
-- conflicted and India has ZERO rows.
--
-- FIX. The real identity of a baseline row is (observation_id, setup_type): one
-- opinion per expert per observation. Challenger rows keep their existing
-- identity, (observation_id, policy_version_id). Two partial indexes, split on
-- whether the row is a challenger, express exactly that.
--
-- Additive and reversible: no row is deleted or rewritten. Existing rows already
-- satisfy both new indexes, so this cannot fail on live data. Backfill is a
-- separate re-run of the producing job, not part of this migration.

BEGIN;

DROP INDEX IF EXISTS public.shadow_decisions_observation_policy_uidx;

-- Baseline experts: one row per (observation, setup_type).
-- NULLS NOT DISTINCT retained so a NULL setup_type cannot duplicate silently —
-- that would recreate the same class of hole this migration closes.
CREATE UNIQUE INDEX IF NOT EXISTS shadow_decisions_observation_setup_uidx
  ON public.shadow_decisions (observation_id, setup_type) NULLS NOT DISTINCT
  WHERE observation_id IS NOT NULL AND policy_version_id IS NULL;

-- Challenger evaluations: unchanged identity, now scoped so it cannot swallow
-- the baseline rows.
CREATE UNIQUE INDEX IF NOT EXISTS shadow_decisions_observation_policy_uidx
  ON public.shadow_decisions (observation_id, policy_version_id)
  WHERE observation_id IS NOT NULL AND policy_version_id IS NOT NULL;

COMMIT;
