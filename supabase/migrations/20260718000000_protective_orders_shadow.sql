-- Hybrid protective stops — SHADOW STATE MODEL (PROPOSAL — NOT YET APPLIED).
--
-- This migration is written as a FILE and reported as a proposal. It is NOT
-- applied to prod by the agent that authored it. Do not treat its existence in
-- supabase/migrations/ as proof it ran.
--
-- SHADOW ONLY. It creates the state model + exit-provenance columns the hybrid
-- protective-stop feature needs, plus a FALSE-BY-DEFAULT placement flag. Nothing
-- here places a broker order. The flag stays false until the owner approves touch
-- semantics (Q1), the floor distance, and the post-fill protection policy.
--
-- It REFERENCES the existing position/execution ledger (broker_orders / positions
-- via ids). It does NOT create a parallel position, cash, or P&L truth layer.

-- ── 1) False-by-default placement flag ────────────────────────────────────────
-- The single money-line gate. Default false; stays false in this scaffold.
alter table public.strategy_config
  add column if not exists protective_orders_enabled boolean not null default false;

comment on column public.strategy_config.protective_orders_enabled is
  'Hybrid protective-stop placement master flag. FALSE by default and MUST stay false until the owner approves touch semantics, floor distance, and post-fill policy. Gates ALL broker-side protective placement.';

-- ── 2) Exit-provenance / learning-attribution columns ─────────────────────────
-- A disaster-floor fill is REAL money: it MUST stay in P&L, NAV, drawdown, mandate
-- and risk-policy evaluation. ONLY the Learner's signal-weight attribution excludes
-- it. A generic excluded_from_learning=true is INSUFFICIENT (the evaluation engine
-- also filters that field, which would wrongly drop the loss from risk evaluation
-- too). So `learning_scope` is EXPLICIT:
--   'full'             → counts everywhere (default, back-compatible).
--   'risk_policy_only' → counts for P&L/NAV/drawdown/risk; EXCLUDED from
--                        signal-weight attribution and genome promotion.
alter table public.paper_trades
  add column if not exists learning_scope text not null default 'full'
    check (learning_scope in ('full','risk_policy_only'));
alter table public.broker_orders
  add column if not exists learning_scope text not null default 'full'
    check (learning_scope in ('full','risk_policy_only'));

comment on column public.paper_trades.learning_scope is
  'Signal-weight learning attribution. risk_policy_only = a protective_disaster_floor exit: real loss kept in P&L/NAV/drawdown/risk evaluation but EXCLUDED from signal-weight attribution + genome promotion. Distinct from excluded_from_learning (which the evaluation engine also honors).';
comment on column public.broker_orders.learning_scope is
  'Signal-weight learning attribution for live fills. risk_policy_only = protective_disaster_floor exit (excluded from weight attribution only; present in P&L/NAV/drawdown/risk).';

-- ── 3) protective_order state table ───────────────────────────────────────────
-- One authoritative record per live position and broker.
create table if not exists public.protective_orders (
  id bigserial primary key,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  -- References into the existing position + execution ledger (no parallel truth).
  position_id text not null,
  proposal_id bigint references public.trade_proposals(id),
  broker_order_id text,          -- resting order id (US) …
  kite_trigger_id text,          -- … or Kite GTT trigger_id (India). Exactly one.

  broker text not null,
  broker_account_id text not null,
  market text not null check (market in ('us','india')),
  symbol text not null,
  currency text check (currency in ('USD','INR')),

  -- Disaster-floor mode (default = wider floor; touch requires owner approval).
  mode text not null default 'wider_disaster_floor'
    check (mode in ('wider_disaster_floor','touch_at_analytical_stop')),
  order_kind text not null check (order_kind in ('stop_market','stop_limit','gtt_limit')),

  analytical_stop numeric not null check (analytical_stop > 0),
  broker_floor numeric not null check (broker_floor > 0),
  trigger_price numeric not null check (trigger_price > 0),
  limit_price numeric check (limit_price is null or limit_price > 0),

  -- Long-only invariant: protected_qty can never exceed reconciled_held_qty.
  protected_qty numeric not null check (protected_qty >= 0),
  reconciled_held_qty numeric not null check (reconciled_held_qty >= 0),
  constraint protective_orders_long_only check (protected_qty <= reconciled_held_qty),

  status text not null default 'placing'
    check (status in ('placing','active','triggered','filled','canceling','canceled','failed','needs_reconcile')),

  broker_version text,
  broker_updated_at timestamptz,
  expiry timestamptz,
  last_reconciled_at timestamptz,

  -- Immutable reason + correlation/idempotency id.
  reason text not null,
  correlation_id text not null,

  -- Exit provenance recorded on a disaster-floor fill.
  exit_reason text check (exit_reason is null or exit_reason = 'protective_disaster_floor'),
  learning_scope text not null default 'full'
    check (learning_scope in ('full','risk_policy_only'))
);

-- One ACTIVE/in-flight protective order per (position, broker) — the cancel/replace
-- qty invariant plus this partial-unique index prevent two resting protective SELLs.
create unique index if not exists protective_orders_one_active_per_position
  on public.protective_orders (position_id, broker)
  where status in ('placing','active','triggered','canceling','needs_reconcile');
create index if not exists protective_orders_recent
  on public.protective_orders (market, symbol, created_at desc);
create unique index if not exists protective_orders_correlation_uniq
  on public.protective_orders (correlation_id);

-- Keep updated_at honest.
create or replace function public.protective_orders_touch_updated_at()
returns trigger language plpgsql set search_path = public as $$
begin
  new.updated_at := now();
  return new;
end $$;
drop trigger if exists protective_orders_set_updated_at on public.protective_orders;
create trigger protective_orders_set_updated_at
before update on public.protective_orders
for each row execute function public.protective_orders_touch_updated_at();

-- ── 4) protective_order_events append-only audit ──────────────────────────────
create table if not exists public.protective_order_events (
  id bigserial primary key,
  protective_order_id bigint not null references public.protective_orders(id),
  created_at timestamptz not null default now(),
  event_type text not null
    check (event_type in ('planned','placed','reconciled','triggered','filled','partial_fill','canceled','expired','failed','needs_reconcile','error')),
  status_before text,
  status_after text,
  detail text not null,
  broker_snapshot jsonb not null default '{}'::jsonb
);
create index if not exists protective_order_events_by_order
  on public.protective_order_events (protective_order_id, created_at desc);

create or replace function public.protective_order_events_immutable()
returns trigger language plpgsql set search_path = public as $$
begin
  raise exception 'protective_order_events is append-only';
end $$;
drop trigger if exists protective_order_events_no_mutation on public.protective_order_events;
create trigger protective_order_events_no_mutation
before update or delete on public.protective_order_events
for each row execute function public.protective_order_events_immutable();

-- ── 5) RLS: owner-read, service-role writes, anon denied ──────────────────────
do $$ declare t text;
begin
  foreach t in array array['protective_orders','protective_order_events'] loop
    execute format('alter table public.%I enable row level security',t);
    execute format('drop policy if exists %I_owner_read on public.%I',t,t);
    execute format('create policy %I_owner_read on public.%I for select to authenticated using (((select auth.jwt())->>''email'')=''vterminater@gmail.com'')',t,t);
    execute format('revoke all on table public.%I from anon',t);
    execute format('revoke insert,update,delete,truncate,references,trigger on table public.%I from authenticated',t);
    execute format('grant select on table public.%I to authenticated',t);
    execute format('grant all on table public.%I to service_role',t);
  end loop;
end $$;
