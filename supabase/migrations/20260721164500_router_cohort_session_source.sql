-- Clarify the authoritative session source after the first live India smoke run.
-- Cohorts use executable ResearchAgent signals only (`session_validated=true`)
-- and persist their `as_of_session`. This is available even when the candidate
-- Router has no candle coverage, allowing the missing bars to be recorded as a
-- failed evaluation instead of making the evaluator itself fail.

comment on column public.evidence_policy_evaluations.market_session_date is
  'Validated completed market session from executable ResearchAgent signals; weekend/holiday staged rows cannot inflate rolling proof.';
