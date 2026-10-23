-- Latest-symbol research reads must include neutral/short and all statuses.
-- The pending-long partial index cannot serve this fail-closed admission query.
-- Add only a read index: no row, grant, RLS, policy or signal-selection changes.
set local lock_timeout = '2s';
set local statement_timeout = '60s';
create index if not exists agent_signals_market_symbol_created_idx
  on public.agent_signals (market, symbol, created_at desc);
