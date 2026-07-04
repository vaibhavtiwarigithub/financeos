-- Migration 049: agent_runs.trigger_source
-- Distinguishes cron/scheduled runs from UI-triggered manual runs, for the
-- Agent History page and Activity trigger tags.

ALTER TABLE agent_runs ADD COLUMN IF NOT EXISTS trigger_source text NOT NULL DEFAULT 'scheduled';
COMMENT ON COLUMN agent_runs.trigger_source IS 'scheduled = cron/Task Scheduler; manual = triggered from UI';
