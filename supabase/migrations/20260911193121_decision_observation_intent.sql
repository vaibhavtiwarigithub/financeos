-- Separate the decision being evaluated from the route that discovered the
-- symbol. `entry_eligible` alone is not an entry-cohort key: held positions are
-- deliberately re-scored and can also clear the entry threshold.
--
-- Historical rows stay immutable. NULL means legacy/unknown; readers may use
-- the frozen discovery_source only as an explicitly labelled legacy mapping.

alter table public.decision_observations
  add column if not exists decision_context text;

alter table public.decision_observations
  drop constraint if exists decision_observations_decision_context_check;

alter table public.decision_observations
  add constraint decision_observations_decision_context_check
  check (decision_context is null or decision_context in ('entry_candidate', 'holding_review'));

comment on column public.decision_observations.decision_context is
  'Immutable decision intent at scoring time: entry_candidate or holding_review. NULL is legacy/unknown; never infer money-path authority from NULL.';

create index if not exists decision_observations_context_market_ts_idx
  on public.decision_observations (decision_context, market, ts desc)
  where decision_context is not null;
