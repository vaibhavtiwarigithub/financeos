-- Risk fix G8 (minimal safe): kill-switch resting-order quarantine.
-- When the kill switch trips it blocks NEW orders but previously-submitted, not-yet-
-- terminal live orders remain at the broker. We do NOT auto-cancel (no deterministic
-- broker cancel is wired, and no cron/LLM may cancel live orders). Instead we flag them
-- for owner review so they are visible and actionable.
alter table broker_orders
  add column if not exists risk_status text,
  add column if not exists risk_status_at timestamptz,
  add column if not exists risk_status_reason text;

comment on column broker_orders.risk_status is 'Non-null when a risk event (e.g. kill_switch_review_required) flags this order for owner review. Never auto-cancelled.';
