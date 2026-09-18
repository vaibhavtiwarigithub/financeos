-- Immutable, program-specific causal evidence.  This is deliberately separate
-- from shadow progress and aggregate paper P&L: one row is one declared
-- baseline-vs-variant comparison for one market and frozen pair of versions.
create table if not exists public.upgrade_path_attribution_runs (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  program_id text not null,
  market text not null check (market in ('us', 'india')),
  program_version text not null,
  baseline_version text not null,
  comparison_type text not null check (comparison_type in ('matched_replay', 'paper_cohort', 'operational_only')),
  state text not null check (state in ('measured', 'collecting', 'not_attributable', 'invalid')),
  as_of_session date not null,
  window_start date,
  window_end date,
  baseline_portfolio_return_pct numeric,
  variant_portfolio_return_pct numeric,
  benchmark_return_pct numeric,
  incremental_return_pct numeric,
  net_incremental_return_pct numeric,
  benchmark_relative_incremental_return_pct numeric,
  drawdown_delta_pct numeric,
  turnover_pct numeric,
  independent_sessions integer,
  ci_lower_pct numeric,
  ci_upper_pct numeric,
  t_statistic numeric,
  matched_population_hash text,
  input_snapshot_hash text,
  cost_model_version text,
  validity_reason text,
  constraints jsonb not null default '{}'::jsonb,
  unique (program_id, market, program_version, baseline_version, as_of_session),
  check (window_start is null or window_end is null or window_end >= window_start),
  check (independent_sessions is null or independent_sessions >= 0),
  check (ci_lower_pct is null or ci_upper_pct is null or ci_lower_pct <= ci_upper_pct),
  check (state <> 'measured' or (
    comparison_type <> 'operational_only'
    and window_start is not null and window_end is not null
    and baseline_portfolio_return_pct is not null and variant_portfolio_return_pct is not null
    and benchmark_return_pct is not null and incremental_return_pct is not null and net_incremental_return_pct is not null
    and benchmark_relative_incremental_return_pct is not null and drawdown_delta_pct is not null and turnover_pct is not null
    and independent_sessions is not null and independent_sessions > 0
    and ci_lower_pct is not null and ci_upper_pct is not null
    and matched_population_hash is not null and input_snapshot_hash is not null and cost_model_version is not null
    and constraints @> '{"same_market":true,"same_window":true,"same_population":true,"non_overlapping_sessions":true,"cost_basis":"net"}'::jsonb
    and abs((variant_portfolio_return_pct - baseline_portfolio_return_pct) - incremental_return_pct) <= 0.000001
    and net_incremental_return_pct <= incremental_return_pct + 0.000001
  ))
);

create index if not exists upgrade_path_attribution_runs_program_market_session_idx
  on public.upgrade_path_attribution_runs (program_id, market, as_of_session desc, created_at desc);

-- The owner reads this only through the existing owner-gated API. No browser
-- role can write, alter, or bypass this ledger; service-role writers will be
-- added only alongside each program's predeclared matched-comparison adapter.
alter table public.upgrade_path_attribution_runs enable row level security;
revoke all on table public.upgrade_path_attribution_runs from anon, authenticated;
grant select on table public.upgrade_path_attribution_runs to authenticated;

drop policy if exists upgrade_path_attribution_runs_owner_read on public.upgrade_path_attribution_runs;
create policy upgrade_path_attribution_runs_owner_read on public.upgrade_path_attribution_runs
  for select to authenticated
  using ((auth.jwt() ->> 'email') = 'vterminater@gmail.com');
