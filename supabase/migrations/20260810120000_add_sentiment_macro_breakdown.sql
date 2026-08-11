-- Add sentiment_breakdown and macro_breakdown columns to signal_score_history
-- These parallel technical_breakdown (already applied) and store per-run sub-indicator data
ALTER TABLE signal_score_history
  ADD COLUMN IF NOT EXISTS sentiment_breakdown jsonb,
  ADD COLUMN IF NOT EXISTS macro_breakdown     jsonb;
