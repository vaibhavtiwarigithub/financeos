-- Part B (Decision 38): time-bound posture presets with auto-revert.
alter table strategy_config
  add column if not exists posture text,
  add column if not exists posture_expires_at timestamptz,
  add column if not exists base_risk_profile text;
