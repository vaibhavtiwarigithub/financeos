-- L4 live-trading infrastructure for crypto (BTC/ETH/SOL, US-only, no India
-- counterpart). Owner-approved 2026-09-23, built after confirming Robinhood
-- crypto's place_crypto_order schema has a real stop_price field (probe
-- evidence: crypto_universe_runs, source='robinhood_mcp_tools_list',
-- observed 2026-09-23 17:31 UTC). Same discipline as the leveraged-sleeve
-- migration: schema and safe-by-default config only, nothing enabled here.

create table if not exists public.crypto_live_positions (
  id uuid primary key default gen_random_uuid(),
  symbol text not null check (symbol in ('BTC', 'ETH', 'SOL')),
  market text not null default 'crypto' check (market = 'crypto'),
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
  -- Crypto's own stop tracking, deliberately NOT reusing protective_orders
  -- (that table + lib/protective/placement-worker.ts are equity-shaped:
  -- keyed to managedLivePositionId's market="us"|"india", Robinhood GTC
  -- stop-market semantics that don't necessarily match crypto's own
  -- time_in_force values). Crypto's stop order id is tracked directly here.
  stop_broker_order_id text,
  stop_status text not null default 'none' check (stop_status in ('none', 'placing', 'active', 'failed', 'canceling', 'canceled', 'needs_reconcile')),
  policy_version text not null,
  rationale text,
  opened_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  closed_at timestamptz,
  close_reason text,
  realized_pnl numeric
);

create unique index if not exists crypto_live_positions_open_symbol_idx
  on public.crypto_live_positions (symbol) where closed_at is null;
create index if not exists crypto_live_positions_symbol_opened_idx
  on public.crypto_live_positions (symbol, opened_at desc);
alter table public.crypto_live_positions enable row level security;

-- Own decoupled flags, same lesson as the leveraged sleeve: never reuse
-- another book's live-enable flags. crypto_live_lease_usd defaults to 0.
alter table public.strategy_config
  add column if not exists crypto_live_auto_enabled boolean not null default false;
alter table public.strategy_config
  add column if not exists crypto_live_lease_usd numeric not null default 0;

comment on table public.crypto_live_positions is
  'L4 live crypto positions (BTC/ETH/SOL). Isolated from equity/leveraged live books and from crypto paper_positions. One open row per symbol max. Broker-native stop tracked via stop_broker_order_id/stop_status.';
comment on column public.strategy_config.crypto_live_lease_usd is
  'Fixed-dollar live capacity for the crypto book (BTC+ETH+SOL combined). 0 = no live capacity (safe default). Never summed with the leveraged sleeve or core-equity live NAV.';
