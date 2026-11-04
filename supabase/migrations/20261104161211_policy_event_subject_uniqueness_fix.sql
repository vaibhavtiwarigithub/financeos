-- PostgreSQL truncated the original generated constraint name to this value.
-- Drop that exact key so event outcomes can be stored once per exposed symbol.
alter table public.market_event_outcomes
  drop constraint if exists market_event_outcomes_event_id_horizon_days_benchmark_symbo_key;

create unique index if not exists market_event_outcomes_event_horizon_benchmark_subject_key
  on public.market_event_outcomes (event_id, horizon_days, benchmark_symbol, subject_symbol) nulls not distinct;
