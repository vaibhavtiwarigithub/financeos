-- Scoring P0: provenance columns + new lifecycle states.
-- No formula change. Purpose:
--   1. Structural tag distinguishing deterministic vs LLM-generated signals.
--   2. Summary columns on decision_observations for future PIT snapshots.
--   3. Three missing lifecycle states on strategy_versions (blocked P4/P5).
-- All new columns nullable so existing rows are unaffected.

-- ── agent_signals ────────────────────────────────────────────────────────────
-- score_source: 'deterministic_v1' | 'llm_advisory' | future values
-- scoring_version: 'v1.0' | future versions aligned to strategy_versions tags
alter table public.agent_signals
  add column if not exists score_source    text,
  add column if not exists scoring_version text;

-- ── decision_observations ─────────────────────────────────────────────────────
-- Summary columns for the canonical PIT snapshot (architecture §6).
-- The existing `features` jsonb blob is preserved as-is (v1 canonical).
-- These columns augment it; they do NOT replace it.
-- NOT VALID range checks: applied retroactively on new rows, not on existing.
alter table public.decision_observations
  add column if not exists score_source           text,
  add column if not exists scoring_version        text,
  add column if not exists setup_type             text,
  add column if not exists rank_score             numeric check (rank_score     is null or (rank_score     >= 0 and rank_score     <= 100)) not valid,
  add column if not exists final_score            numeric check (final_score    is null or (final_score    >= 0 and final_score    <= 100)) not valid,
  add column if not exists evidence_confidence    numeric check (evidence_confidence    is null or (evidence_confidence    >= 0 and evidence_confidence    <= 1)) not valid,
  add column if not exists contradiction_penalty  numeric check (contradiction_penalty  is null or (contradiction_penalty  >= 0 and contradiction_penalty  <= 1)) not valid,
  add column if not exists p_win                  numeric check (p_win          is null or (p_win          >= 0 and p_win          <= 1)) not valid,
  add column if not exists expected_return_bps    numeric,
  add column if not exists universe_snapshot_id   bigint;

-- The append-only trigger (dobs_block_mutation, migration 059) blocks UPDATE/DELETE.
-- New nullable columns added above do NOT affect INSERT — trigger still fires correctly.

-- ── strategy_versions lifecycle states ───────────────────────────────────────
-- Current constraint (migration 065) is missing three states the architecture
-- requires: 'measure_only', 'live_review_eligible', 'live_approved'.
-- The DB has 'approved_live' (old name) — keep it for legacy rows; add the
-- canonical 'live_approved' string that all arch docs and safety gates expect.
-- Additive only: existing state values are preserved.
alter table public.strategy_versions
  drop constraint if exists strategy_versions_state_check;

alter table public.strategy_versions
  add constraint strategy_versions_state_check
  check (state = any (array[
    'draft',
    'testing',
    'rejected',
    'paper_candidate',
    'paper_active',
    'paper_paused',
    'eligible',
    'approved_live',
    'live_paused',
    'retired',
    'shadow_paper',
    'measure_only',
    'live_review_eligible',
    'live_approved'
  ]));
