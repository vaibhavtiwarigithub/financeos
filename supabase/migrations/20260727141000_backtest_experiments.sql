-- Experiment lineage: hypothesis + variant budget committed BEFORE engine runs.
-- Prevents post-hoc variant inflation (multiple-testing trap).
-- LLM proposes bounded hypothesis; engine records what it actually ran.

create table if not exists public.backtest_experiments (
  id                uuid primary key default gen_random_uuid(),
  hypothesis        text not null,
  author            text not null check (author in ('llm', 'human')),
  -- variant_budget is locked at creation; variants_proposed must not exceed it.
  variant_budget    int not null check (variant_budget between 1 and 20),
  variants          jsonb,                           -- structured variant specs, set after LLM proposal
  variants_proposed int check (variants_proposed is null or variants_proposed <= variant_budget),
  variants_run      int,
  experiment_type   text not null default 'ic_segment'
                      check (experiment_type in ('ic_segment', 'parameter_sweep', 'regime_test')),
  market            text check (market in ('us', 'india')),
  segment_type      text check (segment_type in ('market', 'sector', 'regime')),
  segment_value     text,
  started_at        timestamptz,
  completed_at      timestamptz,
  result_summary    jsonb,                           -- structured, not free text
  policy_id         uuid references public.strategy_policies(id),
  created_at        timestamptz not null default now()
);

-- Constraint: variants_proposed <= variant_budget enforced above.
-- Extra: variants_run must not exceed variants_proposed.
alter table public.backtest_experiments
  add constraint backtest_experiments_run_lte_proposed
    check (variants_run is null or variants_proposed is null or variants_run <= variants_proposed);

create index if not exists backtest_experiments_market_idx
  on public.backtest_experiments (market, experiment_type, created_at desc);

create index if not exists backtest_experiments_policy_idx
  on public.backtest_experiments (policy_id)
  where policy_id is not null;

-- Core fields immutable after insert; only completion fields (started_at, completed_at,
-- variants, variants_proposed, variants_run, result_summary, policy_id) may be updated.
create or replace function public.backtest_experiments_guard_mutation()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if (old.hypothesis       is distinct from new.hypothesis or
      old.author           is distinct from new.author or
      old.variant_budget   is distinct from new.variant_budget or
      old.experiment_type  is distinct from new.experiment_type or
      old.market           is distinct from new.market or
      old.segment_type     is distinct from new.segment_type or
      old.segment_value    is distinct from new.segment_value) then
    raise exception 'backtest_experiments: hypothesis, author, budget, type, and segment are immutable after insert';
  end if;
  return new;
end;
$$;

drop trigger if exists backtest_experiments_no_core_mutation on public.backtest_experiments;
create trigger backtest_experiments_no_core_mutation
  before update on public.backtest_experiments
  for each row execute function public.backtest_experiments_guard_mutation();

-- RLS: service role only.
alter table public.backtest_experiments enable row level security;

create policy "service role full access"
  on public.backtest_experiments
  using (auth.role() = 'service_role');
