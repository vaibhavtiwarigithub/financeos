-- Live exit ladder safety correction (2026-09-11).
--
-- These tables exist in production from the initial parity rollout, but their
-- creating migration was not present in the repository. Create-if-missing makes
-- a fresh environment reproducible; the ALTERs correct live state semantics.
-- No order is placed by this migration.

create table if not exists public.live_position_state (
  account_id text not null,
  symbol text not null,
  market text not null check (market in ('us', 'india')),
  highest_price numeric,
  trailing_stop numeric,
  partial_taken_at timestamptz,
  partial_qty numeric,
  opened_at timestamptz not null,
  updated_at timestamptz not null default now(),
  primary key (account_id, symbol)
);

create table if not exists public.live_exit_ladder_shadow (
  id bigserial primary key,
  account_id text not null,
  market text not null check (market in ('us', 'india')),
  symbol text not null,
  evaluated_at timestamptz not null default now(),
  action text not null,
  reason text,
  price numeric not null,
  qty_held numeric not null,
  qty_would_exit numeric,
  trailing_stop numeric,
  runner_stop numeric,
  highest_price numeric,
  paper_action text,
  parity_match boolean,
  shadow_mode boolean not null default true,
  created_at timestamptz not null default now()
);

alter table public.live_position_state
  add column if not exists state_mode text not null default 'legacy'
    check (state_mode in ('legacy', 'shadow', 'executable')),
  add column if not exists direction_flip_armed_session timestamptz;

comment on column public.live_position_state.state_mode is
  'shadow state may never drive executable exits; legacy rows are ignored until initialized in executable mode.';
comment on column public.live_position_state.direction_flip_armed_session is
  'First fresh held-short score session. A live direction flip exits only after a later fresh session confirms it.';

alter table public.live_position_state enable row level security;
alter table public.live_exit_ladder_shadow enable row level security;
