-- Phase 1: Evidence Records — immutable audit trail for every data fetch
-- Every piece of data that influences a trade decision is recorded here.
-- Source tiers: 1=exchange/broker/regulator, 2=structured provider, 3=financial press, 4=web, 5=social

create table if not exists evidence_records (
  id              bigserial primary key,
  symbol          text,
  evidence_type   text not null,  -- 'ohlcv' | 'quote' | 'fundamental' | 'insider' | 'sentiment' | 'macro' | 'earnings' | 'dividend' | 'split' | 'news'
  source          text not null,  -- 'alpha_vantage' | 'financial_datasets' | 'robinhood' | 'stocktwits' | 'fred' | 'price_cache'
  source_tier     integer not null default 2 check (source_tier between 1 and 5),
  observed_at     timestamptz,    -- when the event happened in the real world
  effective_at    timestamptz,    -- when data became valid (ex-date for dividends, etc.)
  retrieved_at    timestamptz not null default now(),
  quality_state   text not null default 'ok' check (quality_state in ('ok', 'stale', 'conflict', 'missing', 'quarantined')),
  payload         jsonb,          -- the raw fetched data
  payload_hash    text,           -- sha256 of payload for dedup/integrity
  signal_id       bigint,
  research_packet_id bigint,
  notes           text
);

alter table evidence_records disable row level security;
create index if not exists er_symbol_type_idx on evidence_records(symbol, evidence_type, retrieved_at desc);
create index if not exists er_type_idx on evidence_records(evidence_type, retrieved_at desc);
create index if not exists er_source_idx on evidence_records(source, source_tier);

-- Immutable — no updates or deletes allowed
create or replace function evidence_records_immutable()
returns trigger language plpgsql as $$
begin
  raise exception 'evidence_records is append-only';
end;
$$;

drop trigger if exists evidence_records_no_update on evidence_records;
create trigger evidence_records_no_update
  before update or delete on evidence_records
  for each row execute function evidence_records_immutable();

-- Corporate actions: splits, dividends, symbol changes
create table if not exists corporate_actions (
  id              bigserial primary key,
  symbol          text not null,
  action_type     text not null,  -- 'split' | 'dividend' | 'symbol_change' | 'halt' | 'delist'
  ex_date         date,
  effective_date  date,
  -- Split fields
  split_ratio     numeric(10,6),  -- e.g. 4.0 for 4:1 split
  -- Dividend fields
  dividend_amount numeric(12,6),
  dividend_type   text,           -- 'regular' | 'special'
  -- Symbol change
  new_symbol      text,
  -- Source
  source          text not null default 'alpha_vantage',
  source_tier     integer not null default 2,
  fetched_at      timestamptz default now(),
  notes           text,
  unique (symbol, action_type, ex_date)
);

alter table corporate_actions disable row level security;
create index if not exists ca_symbol_date_idx on corporate_actions(symbol, ex_date desc);
create index if not exists ca_ex_date_idx on corporate_actions(ex_date desc);

-- Macro vintages: store each MacroSentinel run as a point-in-time observation
-- (macro_signals table already exists — just add vintage_at column)
alter table macro_signals add column if not exists vintage_at timestamptz default now();
alter table macro_signals add column if not exists indicators_json jsonb;  -- raw indicator values at this vintage
