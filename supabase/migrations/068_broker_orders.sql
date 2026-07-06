-- Execution Gateway (spec Part A): typed order lifecycle for broker-routed
-- orders. One row per order attempt. proposal_id references trade_proposals.id
-- (bigint, no hard FK — a proposal may exist without ever getting an order).

create table if not exists broker_orders (
  id               bigserial primary key,
  created_at       timestamptz default now(),
  proposal_id      bigint,
  market           text not null default 'us',
  broker           text not null default 'alpaca',
  broker_env       text not null default 'paper',
  symbol           text not null,
  side             text not null check (side in ('buy','sell')),
  qty              numeric not null,
  order_type       text not null default 'market',
  limit_price      numeric,
  status           text not null default 'pending_submit',
  broker_order_id  text,
  submitted_at     timestamptz,
  filled_qty       numeric default 0,
  avg_fill_price   numeric,
  closed_at        timestamptz,
  raw_last_state   jsonb,
  error            text,
  approved_by_user boolean not null default false
);

alter table broker_orders disable row level security;
create index if not exists border_status_idx on broker_orders(status, created_at desc);
