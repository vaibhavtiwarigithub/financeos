-- L4 live-trading infrastructure for the leveraged sleeve (SOXL/TQQQ/SQQQ/SOXS).
-- Owner-approved 2026-09-23 (features/leveraged-etf-and-intraday-execution/
-- FEATURE_ARCHITECTURE.md's L4 section). This migration ONLY adds schema and
-- safe-by-default config -- it does not enable anything. The lease defaults
-- to 0 (zero live capacity) until the owner sets a real dollar amount, and
-- AUTONOMOUS_LIVE_ENABLED / strategy_config.live_auto_enabled /
-- protective_orders_enabled all remain independently false.

-- A dedicated, isolated live position ledger for the leveraged sleeve --
-- mirrors the paper_positions/position_role pattern already used for SOXL/
-- TQQQ/SQQQ/SOXS paper, rather than reusing the AutonomousLive FIFO
-- reconstruction (which requires a trade_proposals policy_snapshot lineage
-- the leveraged sleeve's own deterministic entry planning doesn't produce).
create table if not exists public.leveraged_live_positions (
  id uuid primary key default gen_random_uuid(),
  symbol text not null check (symbol in ('SOXL', 'TQQQ', 'SQQQ', 'SOXS')),
  market text not null default 'us' check (market = 'us'),
  broker text not null default 'robinhood',
  broker_account_id text not null,
  qty numeric not null check (qty > 0),
  avg_cost numeric not null check (avg_cost > 0),
  current_price numeric,
  stop_loss numeric not null,
  initial_stop_loss numeric not null,
  price_target numeric not null,
  highest_price numeric not null,
  entry_broker_order_id text not null,
  protective_order_id bigint references public.protective_orders(id),
  policy_version text not null,
  rationale text,
  opened_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  closed_at timestamptz,
  close_reason text,
  realized_pnl numeric
);

-- Long-only, no-pyramiding: at most one OPEN row per symbol at a time.
create unique index if not exists leveraged_live_positions_open_symbol_idx
  on public.leveraged_live_positions (symbol) where closed_at is null;

create index if not exists leveraged_live_positions_symbol_opened_idx
  on public.leveraged_live_positions (symbol, opened_at desc);

alter table public.leveraged_live_positions enable row level security;
-- Service-role only -- same posture as paper_positions and protective_orders.
-- No anon/authenticated grants.

-- Per-symbol override of the min-paper-trades-before-live gate. Empty table
-- = no overrides = every symbol needs 10 closed paper trades before its live
-- door will fire. An owner override is explicit, logged, and reversible by
-- deleting the row -- never a silent bypass.
create table if not exists public.leveraged_live_overrides (
  symbol text primary key check (symbol in ('SOXL', 'TQQQ', 'SQQQ', 'SOXS')),
  min_paper_trades_override boolean not null default false,
  note text,
  set_at timestamptz not null default now()
);
alter table public.leveraged_live_overrides enable row level security;

-- Lease config: fixed-dollar, NOT a percentage of NAV, NOT Kelly-sized (see
-- FEATURE_ARCHITECTURE.md part 4). Defaults to 0 -- zero live capacity --
-- until the owner sets a real number. This is the actual "go live" control
-- for the leveraged sleeve, independent of (in addition to) the existing
-- AUTONOMOUS_LIVE_ENABLED / live_auto_enabled dual gate.
alter table public.strategy_config
  add column if not exists leveraged_sleeve_live_lease_usd numeric not null default 0;

comment on table public.leveraged_live_positions is
  'L4 live leveraged-sleeve positions (SOXL/TQQQ/SQQQ/SOXS). Isolated from AutonomousLive''s FIFO reconstruction and from paper_positions. One open row per symbol max.';
comment on table public.leveraged_live_overrides is
  'Per-symbol override of the 10-closed-paper-trades-before-live gate. Explicit, logged, reversible.';
comment on column public.strategy_config.leveraged_sleeve_live_lease_usd is
  'Fixed-dollar live capacity for the combined SOXL+TQQQ+SQQQ+SOXS sleeve. 0 = no live capacity (safe default). Not a % of NAV, not Kelly-sized.';
