-- Paper Order Events — Phase 0
-- Append-only immutable event log for all paper trading activity.
-- paper_trades and paper_positions remain as mutable projections (readable, fast).
-- Every fill, cash movement, and valuation is also recorded here for auditability.

create table if not exists paper_order_events (
  id              bigserial primary key,
  event_type      text not null,          -- 'fill' | 'cash_move' | 'valuation' | 'position_close' | 'order_intent'
  symbol          text,
  side            text,                   -- 'buy' | 'sell' | null
  qty             integer,
  fill_price      numeric(12,4),
  total_value     numeric(14,2),
  -- Price provenance (Phase 0 requirement: every price must be sourced)
  price_source    text not null default 'unknown',  -- 'alpha_vantage' | 'price_cache' | 'manual'
  price_retrieved_at timestamptz,
  bid_at_fill     numeric(12,4),
  ask_at_fill     numeric(12,4),
  spread_applied  numeric(8,5),           -- actual spread/slippage applied (e.g. 0.0005)
  -- References
  signal_id       bigint,
  paper_trade_id  bigint,
  -- Context
  analyst_score   integer,
  strategy_id     text,
  notes           text,
  created_at      timestamptz default now()
);

alter table paper_order_events disable row level security;
create index if not exists poe_symbol_idx on paper_order_events(symbol, created_at desc);
create index if not exists poe_type_idx on paper_order_events(event_type, created_at desc);

-- Immutability trigger: prevent UPDATE or DELETE on paper_order_events
create or replace function paper_order_events_immutable()
returns trigger language plpgsql as $$
begin
  raise exception 'paper_order_events is append-only — updates and deletes are not allowed';
end;
$$;

drop trigger if exists paper_order_events_no_update on paper_order_events;
create trigger paper_order_events_no_update
  before update or delete on paper_order_events
  for each row execute function paper_order_events_immutable();

-- Add price_source column to paper_trades for Phase 0 provenance tracking
alter table paper_trades add column if not exists price_source text default 'unknown';
alter table paper_trades add column if not exists price_retrieved_at timestamptz;
alter table paper_trades add column if not exists spread_applied numeric(8,5) default 0.0005;
alter table paper_trades add column if not exists paper_event_id bigint;
