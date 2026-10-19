-- Preserve the exact numeric dimension contribution behind each Router score
-- so aggregate score drift can be diagnosed without recomputing from mutable data.
-- The evaluation/detail ledgers are append-only and service-role written.

alter table public.evidence_evaluation_details
  add column if not exists legacy_score_trace jsonb not null default '{}'::jsonb,
  add column if not exists candidate_score_trace jsonb not null default '{}'::jsonb;

comment on column public.evidence_evaluation_details.legacy_score_trace is
  'Frozen dimension scores, availability, base/effective weights, weighted contributions, pre/post ETF cap score for the legacy arm; numeric diagnostics only.';
comment on column public.evidence_evaluation_details.candidate_score_trace is
  'Frozen dimension scores, availability, base/effective weights, weighted contributions, pre/post ETF cap score for the candidate arm; numeric diagnostics only.';

-- Historical rows intentionally remain empty: their component-level traces
-- cannot be reconstructed safely from current providers or current weights.
