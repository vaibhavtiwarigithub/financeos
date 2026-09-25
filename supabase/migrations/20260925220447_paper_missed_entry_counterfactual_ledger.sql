-- Frozen decision-time record of valid long entries that paper execution could
-- not place for an observable capacity or cash reason.
begin;
create table if not exists public.paper_missed_opportunities (
  id uuid primary key default gen_random_uuid(),
  attempt_key text not null unique,
  signal_id uuid not null,
  run_id uuid,
  market text not null check (market in ('us','india')),
  symbol text not null,
  decision_at timestamptz not null,
  reference_price numeric not null check (reference_price > 0),
  hypothetical_fill_price numeric not null check (hypothetical_fill_price > 0),
  hypothetical_qty numeric check (hypothetical_qty > 0),
  hypothetical_notional numeric check (hypothetical_notional > 0),
  currency text not null check (currency in ('USD','INR')),
  entry_score numeric not null,
  block_reason text not null,
  block_detail jsonb not null default '{}'::jsonb,
  price_source text not null,
  price_retrieved_at timestamptz,
  stop_loss numeric,
  price_target numeric,
  horizon_sessions integer not null check (horizon_sessions > 0),
  risk_plan jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index if not exists paper_missed_opportunities_market_time_idx
  on public.paper_missed_opportunities(market, decision_at desc);
create index if not exists paper_missed_opportunities_signal_idx
  on public.paper_missed_opportunities(signal_id, market);
alter table public.paper_missed_opportunities enable row level security;
drop policy if exists paper_missed_opportunities_owner_read on public.paper_missed_opportunities;
create policy paper_missed_opportunities_owner_read on public.paper_missed_opportunities
  for select to authenticated using (((select auth.jwt()) ->> 'email') = 'vterminater@gmail.com');
revoke all on public.paper_missed_opportunities from anon, authenticated;
grant select on public.paper_missed_opportunities to authenticated;
grant select, insert on public.paper_missed_opportunities to service_role;
comment on table public.paper_missed_opportunities is
  'Frozen, capacity-blocked eligible paper-entry snapshots. Forward marks are diagnostic counterfactuals only and never mutate scoring or trading.';
commit;
