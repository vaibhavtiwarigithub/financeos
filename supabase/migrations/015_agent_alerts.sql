-- Restore production's original agent_alerts baseline (migration
-- 20260629192707 / 015_agent_alerts), which was missing from the tracked chain.
-- Migration 099 adds issue_key and its partial unique index later.

CREATE TABLE IF NOT EXISTS public.agent_alerts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at TIMESTAMPTZ DEFAULT now(),
  severity TEXT NOT NULL DEFAULT 'warn',
  category TEXT NOT NULL,
  title TEXT NOT NULL,
  detail TEXT,
  resolved BOOLEAN DEFAULT false,
  resolved_at TIMESTAMPTZ,
  auto_expire_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS alerts_resolved_idx
  ON public.agent_alerts (resolved, created_at DESC);

ALTER TABLE public.agent_alerts ENABLE ROW LEVEL SECURITY;
