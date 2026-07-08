-- Caches Upstox's tradingsymbol -> instrument_key map for India market data.
-- Upstox keys instruments by NSE_EQ|<ISIN>, not by ticker, so lib/data/upstox.ts
-- resolves e.g. RELIANCE -> NSE_EQ|INE002A01018 via this table. Populated from
-- Upstox's official NSE instrument master (assets.upstox.com NSE.json.gz),
-- filtered to cash equities, refreshed at most weekly (never parsed per request).

create table if not exists upstox_instruments (
  trading_symbol text primary key,
  instrument_key text not null,
  isin text,
  name text,
  updated_at timestamptz not null default now()
);
alter table upstox_instruments enable row level security;
revoke all on table upstox_instruments from anon, authenticated;
create index if not exists upstox_instruments_updated_idx on upstox_instruments(updated_at desc);
