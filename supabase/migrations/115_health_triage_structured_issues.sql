-- Self-healing B3: structured per-issue triage rows.
-- The health-triage LLM now outputs JSON with a structured `issues` array
-- (issue_key, severity, root_cause, blast_radius, suggested_fix) rather than
-- a plain-English blob. This column stores that array so B4 apply-button UI
-- components have machine-readable per-issue data to act on.
-- `content` stays for the narrative summary (backward-compatible).

alter table health_triage
  add column if not exists structured_issues jsonb;

comment on column health_triage.structured_issues is
  'Array of structured triage issues: [{issue_key, severity, root_cause, blast_radius, suggested_fix}]. Null for legacy rows. Enables B4 apply-button UI.';
