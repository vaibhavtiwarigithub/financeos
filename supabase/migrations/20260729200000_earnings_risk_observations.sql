-- Earnings-aware risk P0 shadow ledger.
-- Measure-only: this table cannot change scores, eligibility, sizing, stops,
-- targets, proposals, fills, or exits. Source payloads remain in their existing
-- evidence/cache stores; this ledger contains only normalized decision context.

create table if not exists public.earnings_risk_observations (
  id bigint generated always as identity primary key,
  idempotency_key text not null unique,
  market text not null check (market in ('us', 'india')),
  environment text not null check (environment in ('paper', 'live', 'position', 'probe')),
  decision_kind text not null check (decision_kind in ('entry', 'rotation', 'holding', 'contract_probe')),
  signal_id uuid,
  proposal_id bigint references public.trade_proposals(id),
  symbol text not null,
  observed_at timestamptz not null,
  report_date date,
  report_session text not null check (report_session in ('bmo', 'amc', 'during_session', 'unknown')),
  sessions_until_report integer,
  earnings_status text not null check (earnings_status in ('available', 'unknown', 'conflict')),
  earnings_source text,
  earnings_confidence text not null check (earnings_confidence in ('confirmed', 'estimated', 'unknown')),
  options_source text check (options_source is null or options_source in ('robinhood', 'yahoo')),
  options_quality text not null check (options_quality in ('usable', 'wide_spread', 'stale', 'illiquid', 'unavailable')),
  expiry date,
  quote_as_of timestamptz,
  spot numeric check (spot is null or spot > 0),
  strike numeric check (strike is null or strike > 0),
  call_bid numeric check (call_bid is null or call_bid >= 0),
  call_ask numeric check (call_ask is null or call_ask >= 0),
  put_bid numeric check (put_bid is null or put_bid >= 0),
  put_ask numeric check (put_ask is null or put_ask >= 0),
  move_proxy_pct numeric check (move_proxy_pct is null or move_proxy_pct >= 0),
  stop_distance_pct numeric check (stop_distance_pct is null or stop_distance_pct >= 0),
  stop_to_move_ratio numeric check (stop_to_move_ratio is null or stop_to_move_ratio >= 0),
  policy_version integer not null check (policy_version > 0),
  policy_mode text not null check (policy_mode = 'shadow'),
  counterfactual_verdict text not null check (counterfactual_verdict in ('allow', 'block', 'size_down', 'unknown')),
  counterfactual_reason text not null,
  behavior_changed boolean not null default false check (behavior_changed = false),
  legacy_gate_blocked boolean not null default false,
  source_observations jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists earnings_risk_observations_market_time_idx
  on public.earnings_risk_observations (market, observed_at desc);
create index if not exists earnings_risk_observations_symbol_time_idx
  on public.earnings_risk_observations (market, symbol, observed_at desc);
create index if not exists earnings_risk_observations_acceptance_idx
  on public.earnings_risk_observations (environment, decision_kind, observed_at desc);
create index if not exists earnings_risk_observations_proposal_idx
  on public.earnings_risk_observations (proposal_id)
  where proposal_id is not null;

alter table public.earnings_risk_observations enable row level security;

create policy earnings_risk_service_all
  on public.earnings_risk_observations
  for all to service_role
  using (true) with check (true);

create policy earnings_risk_owner_read
  on public.earnings_risk_observations
  for select to authenticated
  using (((select auth.jwt()) ->> 'email') = 'vterminater@gmail.com');

revoke all on table public.earnings_risk_observations from anon, authenticated, service_role;
grant select on table public.earnings_risk_observations to authenticated;
grant select, insert on table public.earnings_risk_observations to service_role;
grant usage, select on sequence public.earnings_risk_observations_id_seq to service_role;

drop trigger if exists earnings_risk_observations_immutable on public.earnings_risk_observations;
create trigger earnings_risk_observations_immutable
  before update or delete on public.earnings_risk_observations
  for each row execute function public.evidence_block_mutation();
