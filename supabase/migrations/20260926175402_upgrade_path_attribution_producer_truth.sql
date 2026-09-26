-- Attribution needs both arms' gross AND net portfolio returns. Requiring a
-- scheduled producer to be explicit prevents a silent "collecting" claim.
alter table public.upgrade_path_attribution_runs
  add column if not exists baseline_net_portfolio_return_pct numeric,
  add column if not exists variant_net_portfolio_return_pct numeric;

alter table public.upgrade_path_attribution_runs
  drop constraint if exists upgrade_path_attribution_runs_state_check;
alter table public.upgrade_path_attribution_runs
  add constraint upgrade_path_attribution_runs_state_check
  check (state in ('measured', 'collecting', 'producer_missing', 'not_attributable', 'invalid'));

-- Keep the original measured-row integrity contract and additionally verify
-- exact net-arm arithmetic.
alter table public.upgrade_path_attribution_runs
  drop constraint if exists upgrade_path_attribution_runs_measured_contract_check;
alter table public.upgrade_path_attribution_runs
  add constraint upgrade_path_attribution_runs_measured_contract_check
  check (state <> 'measured' or (
    comparison_type <> 'operational_only'
    and window_start is not null and window_end is not null
    and baseline_portfolio_return_pct is not null and variant_portfolio_return_pct is not null
    and baseline_net_portfolio_return_pct is not null and variant_net_portfolio_return_pct is not null
    and benchmark_return_pct is not null and incremental_return_pct is not null
    and net_incremental_return_pct is not null and benchmark_relative_incremental_return_pct is not null
    and drawdown_delta_pct is not null and turnover_pct is not null
    and independent_sessions is not null and independent_sessions >= 2
    and ci_lower_pct is not null and ci_upper_pct is not null
    and matched_population_hash is not null and input_snapshot_hash is not null and cost_model_version is not null
    and constraints @> '{"same_market":true,"same_window":true,"same_population":true,"non_overlapping_sessions":true,"cost_basis":"net"}'::jsonb
    and abs((variant_portfolio_return_pct - baseline_portfolio_return_pct) - incremental_return_pct) <= 0.000001
    and abs((variant_net_portfolio_return_pct - baseline_net_portfolio_return_pct) - net_incremental_return_pct) <= 0.000001
    and abs(((variant_net_portfolio_return_pct - benchmark_return_pct) - (baseline_net_portfolio_return_pct - benchmark_return_pct)) - benchmark_relative_incremental_return_pct) <= 0.000001
  ));

alter table public.international_allocation_replay_runs
  add column if not exists trigger_source text not null default 'manual_legacy';
alter table public.international_allocation_replay_runs
  drop constraint if exists international_allocation_replay_runs_trigger_source_check;
alter table public.international_allocation_replay_runs
  add constraint international_allocation_replay_runs_trigger_source_check
  check (trigger_source in ('scheduled', 'owner_manual', 'manual_legacy'));

comment on column public.upgrade_path_attribution_runs.baseline_net_portfolio_return_pct is 'Full-window baseline portfolio return after the declared cost model.';
comment on column public.upgrade_path_attribution_runs.variant_net_portfolio_return_pct is 'Full-window variant portfolio return after the declared cost model.';

create or replace function public.reject_upgrade_path_attribution_mutation()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  raise exception 'upgrade_path_attribution_runs is append-only';
end;
$$;

revoke all on function public.reject_upgrade_path_attribution_mutation() from public, anon, authenticated;
drop trigger if exists upgrade_path_attribution_runs_append_only on public.upgrade_path_attribution_runs;
create trigger upgrade_path_attribution_runs_append_only
before update or delete on public.upgrade_path_attribution_runs
for each row execute function public.reject_upgrade_path_attribution_mutation();
revoke update, delete, truncate on public.upgrade_path_attribution_runs from public, anon, authenticated, service_role;

-- Run after the US close and cache refresh window. The endpoint verifies the
-- vault-backed cron secret, reads only persisted price_cache bars, and can only
-- append replay evidence; it cannot change allocation policy or place trades.
do $$ begin
  perform cron.unschedule('kairos-international-allocation-replay-us');
exception when others then null;
end $$;

select cron.schedule(
  'kairos-international-allocation-replay-us', '45 23 * * 1-5',
  $$select public.kairos_call_agent('/api/allocation/international/replay', '{}'::jsonb, 'POST', 30000)$$
);
