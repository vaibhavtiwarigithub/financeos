-- Latest deterministic readiness projection over immutable edge_ic_history.
-- This table is measure-only and grants no scoring or trading authority.

create table if not exists public.edge_readiness_status (
  edge_id text not null references public.edge_catalog(edge_id),
  market text not null check (market in ('us','india')),
  horizon integer not null check (horizon > 0),
  policy_version text not null,
  stage text not null check (stage in (
    'collecting','needs_stability','ready_for_validation_build','ready_for_shadow_review'
  )),
  windows_observed integer not null check (windows_observed >= 0),
  windows_required integer not null check (windows_required > 0),
  positive_windows integer not null check (positive_windows >= 0),
  median_ic numeric,
  median_t_stat numeric,
  min_n_obs integer check (min_n_obs is null or min_n_obs >= 0),
  latest_window_end date,
  validation_windows_observed integer not null check (validation_windows_observed >= 0),
  validation_windows_required integer not null check (validation_windows_required > 0),
  positive_validation_windows integer not null check (positive_validation_windows >= 0),
  median_net_of_fee_ic numeric,
  next_action text not null,
  gates jsonb not null default '{}'::jsonb,
  validation_build_notified_at timestamptz,
  shadow_review_notified_at timestamptz,
  evaluated_at timestamptz not null default now(),
  primary key (edge_id, market, horizon)
);

alter table public.edge_readiness_status enable row level security;
revoke all on table public.edge_readiness_status from anon, authenticated;

create index if not exists edge_readiness_status_market_stage_idx
  on public.edge_readiness_status (market, stage, evaluated_at desc);

do $$ begin
  perform cron.unschedule('kairos-edge-readiness');
exception when others then null;
end $$;

select cron.schedule(
  'kairos-edge-readiness', '20 3 * * 1',
  $$select public.kairos_call_agent('/api/agents/edge-readiness', '{}'::jsonb, 'POST', 60000)$$
);

comment on table public.edge_readiness_status is
  'Measure-only latest readiness projection. Milestones request validation/review and never grant trade authority.';
