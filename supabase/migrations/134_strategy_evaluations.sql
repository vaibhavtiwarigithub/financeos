-- Migration 134: strategy_evaluations table (append-only)
-- Summary of mandate-scoped evaluation runs. References validation_experiments (canonical WF ledger).
-- Never updated — trigger blocks all updates/deletes.

create table public.strategy_evaluations (
  id                       uuid primary key default gen_random_uuid(),
  mandate_id               uuid not null references public.investment_mandates(id),
  -- Snapshot of mandate row at evaluation time. Evaluations reproducible even if mandate config changes.
  mandate_snapshot         jsonb not null,
  market                   text not null,
  evaluated_at             timestamptz not null default now(),
  evaluator_version        text not null,   -- VERCEL_GIT_COMMIT_SHA or 'local'

  -- Input dataset bounds (idempotency / duplicate-run detection)
  dataset_hash             text,            -- sha256 prefix of sorted closed_at timestamps
  window_start             date,
  window_end               date,

  -- Trade counts (always populated)
  n_trades_total           int not null default 0,
  n_trades_evaluable       int not null default 0,  -- excludes tainted + excluded_from_learning
  tainted_count            int not null default 0,
  excluded_count           int not null default 0,
  n_observations           int,

  -- Book metrics (from closed paper_trades + paper_performance NAV)
  -- These are WHOLE-BOOK metrics (paper_performance has no mandate column).
  -- Null when n_trades_evaluable < 20.
  book_sharpe              numeric,
  book_sortino             numeric,
  book_max_drawdown        numeric,
  book_win_rate            numeric,
  book_expectancy_pct      numeric,
  book_alpha_pct           numeric,
  book_benchmark_symbol    text,
  book_cost_adjusted_return_pct numeric,
  book_slip_vs_modeled_bps numeric,

  -- Opportunity-level metrics (decision_observations × observation_labels)
  -- Null until P1: observation_labels mature + mandate filter wired.
  opp_n_labeled            int,
  opp_hit_rate             numeric,
  opp_benchmark_neutral_expectancy numeric,
  opp_ic                   numeric,
  opp_t_stat               numeric,
  -- False until a PIT-safe universe snapshot exists (edge_universe_members is NOT PIT-safe).
  universe_pit_safe        boolean not null default false,

  -- Walk-forward validation reference (validation_experiments is the canonical WF ledger).
  -- strategy_evaluations summarises / references it — does NOT replace it.
  validation_experiment_id bigint references validation_experiments(id),
  walk_forward_folds       jsonb,  -- [{fold, start_date, end_date, n_effective, p_improvement, passed}]

  -- P0 display health flag. NOT a live-trading promotion gate.
  -- 'insufficient_sample' | 'negative_or_zero_edge' | 'promising_but_unvalidated' | 'validation_required'
  health_label             text not null default 'insufficient_sample',
  health_reason            text,

  -- P1 promotion gate: only LearnerAgent sets this true after walk-forward passes.
  promotion_eligible       boolean not null default false,

  created_at               timestamptz not null default now()
);

alter table public.strategy_evaluations enable row level security;

create index se_mandate_market_idx
  on public.strategy_evaluations(mandate_id, market, evaluated_at desc);

-- Append-only: block all updates and deletes
create or replace function se_no_update()
  returns trigger language plpgsql as $$
begin
  raise exception 'strategy_evaluations is append-only — write a new row instead';
end;
$$;

create trigger se_no_update_trigger
  before update or delete on public.strategy_evaluations
  for each row execute function se_no_update();
