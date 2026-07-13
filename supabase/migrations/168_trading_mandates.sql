create table if not exists public.trading_mandates (
  market text primary key check (market in ('us','india')),
  horizon_style text not null check (horizon_style in ('short_swing','swing','position')),
  strategy_preference text not null check (strategy_preference in ('adaptive','momentum','balanced','value_quality')),
  horizon_governance text not null default 'user' check (horizon_governance in ('user','agent')),
  min_hold_days int not null check (min_hold_days between 2 and 20),
  target_hold_days int not null check (target_hold_days between 2 and 20),
  max_hold_days int not null check (max_hold_days between 2 and 20),
  score_threshold numeric not null check (score_threshold between 0 and 100),
  stop_loss_pct numeric not null check (stop_loss_pct between 1 and 30),
  target_pct numeric not null check (target_pct between 1 and 100),
  existing_positions_policy text not null default 'grandfather' check (existing_positions_policy in ('grandfather','apply')),
  version int not null default 1 check (version > 0),
  updated_by uuid references auth.users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (min_hold_days <= target_hold_days and target_hold_days <= max_hold_days)
);

alter table public.trading_mandates enable row level security;
revoke all on public.trading_mandates from anon;
revoke all on public.trading_mandates from authenticated;
grant select on public.trading_mandates to authenticated;
create policy trading_mandates_owner_read on public.trading_mandates for select to authenticated
  using ((auth.jwt() ->> 'email') = 'vterminater@gmail.com');

insert into public.trading_mandates
  (market,horizon_style,strategy_preference,horizon_governance,min_hold_days,target_hold_days,max_hold_days,score_threshold,stop_loss_pct,target_pct,existing_positions_policy)
values
  ('us','swing','balanced','user',5,10,15,60,7,20,'grandfather'),
  ('india','swing','balanced','user',5,10,15,60,7,20,'grandfather')
on conflict (market) do nothing;

alter table public.paper_positions
  add column if not exists mandate_version int,
  add column if not exists mandate_snapshot jsonb,
  add column if not exists resolved_horizon_days int;

alter table public.paper_trades
  add column if not exists mandate_version int,
  add column if not exists mandate_snapshot jsonb,
  add column if not exists resolved_horizon_days int;
