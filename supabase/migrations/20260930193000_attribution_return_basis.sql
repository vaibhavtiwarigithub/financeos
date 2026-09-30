-- Some forward shadow books are sourced from actual paper fills whose execution
-- costs are already embedded in the persisted fill prices. Those books can
-- support honest net attribution, but cannot reconstruct gross returns. Make
-- that limitation explicit instead of forcing a fabricated gross/net pair.
alter table public.upgrade_path_attribution_runs
  add column if not exists return_basis text not null default 'gross_and_net';

alter table public.upgrade_path_attribution_runs
  drop constraint if exists upgrade_path_attribution_runs_return_basis_check;
alter table public.upgrade_path_attribution_runs
  add constraint upgrade_path_attribution_runs_return_basis_check
  check (return_basis in ('gross_and_net', 'net_only'));

alter table public.upgrade_path_attribution_runs
  drop constraint if exists upgrade_path_attribution_runs_measured_contract_check;
alter table public.upgrade_path_attribution_runs
  add constraint upgrade_path_attribution_runs_measured_contract_check
  check (state <> 'measured' or (
    comparison_type <> 'operational_only'
    and window_start is not null and window_end is not null
    and baseline_net_portfolio_return_pct is not null and variant_net_portfolio_return_pct is not null
    and benchmark_return_pct is not null and net_incremental_return_pct is not null
    and benchmark_relative_incremental_return_pct is not null and drawdown_delta_pct is not null and turnover_pct is not null
    and independent_sessions is not null and independent_sessions >= 2
    and ci_lower_pct is not null and ci_upper_pct is not null
    and matched_population_hash is not null and input_snapshot_hash is not null and cost_model_version is not null
    and constraints @> '{"same_market":true,"same_window":true,"same_population":true,"non_overlapping_sessions":true,"cost_basis":"net"}'::jsonb
    and abs((variant_net_portfolio_return_pct - baseline_net_portfolio_return_pct) - net_incremental_return_pct) <= 0.000001
    and abs(((variant_net_portfolio_return_pct - benchmark_return_pct) - (baseline_net_portfolio_return_pct - benchmark_return_pct)) - benchmark_relative_incremental_return_pct) <= 0.000001
    and (
      (return_basis = 'gross_and_net'
        and baseline_portfolio_return_pct is not null and variant_portfolio_return_pct is not null and incremental_return_pct is not null
        and abs((variant_portfolio_return_pct - baseline_portfolio_return_pct) - incremental_return_pct) <= 0.000001)
      or
      (return_basis = 'net_only'
        and baseline_portfolio_return_pct is null and variant_portfolio_return_pct is null and incremental_return_pct is null)
    )
  ));

comment on column public.upgrade_path_attribution_runs.return_basis is
  'gross_and_net: both return bases are independently available. net_only: source fills already include execution costs, so only cost-inclusive portfolio returns are reported; gross fields remain NULL.';
