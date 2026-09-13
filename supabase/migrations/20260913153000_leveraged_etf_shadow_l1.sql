-- L1 leveraged ETF evidence only. This table has no execution consumer.
-- It is intentionally unapplied until repository/production migration lineage
-- is reconciled; never use direct SQL as a deployment bypass.
create table if not exists public.leveraged_etf_shadow_observations (
  id bigint generated always as identity primary key,
  market text not null check (market = 'us'),
  market_session date not null,
  observed_at timestamptz not null,
  symbol text not null check (symbol in ('TQQQ', 'SOXL')),
  underlying_symbol text not null check (underlying_symbol in ('QQQ', 'SOXX')),
  policy_version text not null,
  observation_window text not null check (observation_window in ('inside_1100_et', 'outside_1100_et')),
  measurement_status text not null check (measurement_status in ('complete', 'incomplete')),
  missing jsonb not null default '[]'::jsonb,
  features jsonb not null,
  quote jsonb not null,
  decision text not null check (decision = 'observe_only'),
  created_at timestamptz not null default now(),
  unique (market_session, symbol, policy_version)
);

alter table public.leveraged_etf_shadow_observations enable row level security;
revoke all on public.leveraged_etf_shadow_observations from public, anon, authenticated;
create policy leveraged_etf_shadow_owner_read on public.leveraged_etf_shadow_observations
  for select to authenticated using ((select auth.jwt() ->> 'email') = 'vterminater@gmail.com');
create policy leveraged_etf_shadow_service_insert on public.leveraged_etf_shadow_observations
  for insert to service_role with check (true);

create or replace function public.leveraged_etf_shadow_observations_no_mutate()
returns trigger language plpgsql set search_path = public as $$
begin
  raise exception 'leveraged_etf_shadow_observations is append-only';
end;
$$;
create trigger leveraged_etf_shadow_observations_no_mutate_trg
before update or delete on public.leveraged_etf_shadow_observations
for each row execute function public.leveraged_etf_shadow_observations_no_mutate();

comment on table public.leveraged_etf_shadow_observations is
  'L1 evidence-only measurements for TQQQ/SOXL. No paper/live/order/score consumer is permitted.';
