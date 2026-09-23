-- Per-symbol override of the 10-closed-paper-trades-before-live gate for
-- crypto, mirroring leveraged_live_overrides. Explicit, logged, reversible.
create table if not exists public.crypto_live_overrides (
  symbol text primary key check (symbol in ('BTC', 'ETH', 'SOL')),
  min_paper_trades_override boolean not null default false,
  note text,
  set_at timestamptz not null default now()
);
alter table public.crypto_live_overrides enable row level security;
comment on table public.crypto_live_overrides is
  'Per-symbol override of the 10-closed-paper-trades-before-live gate for crypto. Explicit, logged, reversible.';
