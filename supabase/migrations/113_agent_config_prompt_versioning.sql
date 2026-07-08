-- Prompt versioning for agent_config (Strategic Report §03 — Next Sprint item #7).
-- Adds columns so each agent's system prompt is version-tracked and each run can
-- log which prompt it executed under. Without this, LearnerAgent cannot correlate
-- behavioral drift with prompt changes — a behavioral shift and a prompt edit on
-- the same day are indistinguishable. Additive columns; no existing data affected.

alter table agent_config
  add column if not exists prompt_version  text,        -- human-readable version tag (e.g. "v2", "2026-07-08")
  add column if not exists prompt_hash     text,        -- SHA-256 of the prompt text (first 16 chars); detect silent drifts
  add column if not exists prompt_notes    text,        -- what changed in this version (reviewer changelog)
  add column if not exists prompt_updated_at timestamptz; -- when this prompt version was last written

-- agent_runs: track which prompt version each run executed under.
-- Allows LearnerAgent to join: "did hypothesis X only appear after prompt vY?"
alter table agent_runs
  add column if not exists prompt_version  text,
  add column if not exists prompt_hash     text;

comment on column agent_config.prompt_version  is 'Human-readable prompt version tag. Set when the system prompt is deliberately updated.';
comment on column agent_config.prompt_hash     is 'SHA-256[:16] of the prompt text. Auto-detectable drift signal — if hash changes without a version bump, a code edit silently changed behaviour.';
comment on column agent_config.prompt_notes    is 'What changed in this version. Mirrors the same changelog discipline as FEATURE_ARCHITECTURE.md.';
comment on column agent_runs.prompt_version    is 'Prompt version from agent_config at run time. Enables correlating behavioural changes with prompt changes in learner analysis.';
