-- Scaffolding for the (approved-in-part) Robinhood MCP feature: account
-- allowlist + per-market account selector, snapshot-source switch, a dedicated
-- kill switch for the MCP integration (default OFF — a live-order integration's
-- switch must never ship pre-armed), and a hard notional cap for the Gateway.
-- No OAuth/token code here — that half is blocked on Robinhood's real OAuth
-- endpoints. These columns/tables are inert until that lands.

-- Allowlist of accounts the app may ever touch. Order-path code validates the
-- resolved account against this table with role='trading'; a newly linked
-- account defaults to view_only and can never be a live target until the user
-- explicitly promotes it. Service-role-only — a client writer would defeat the
-- allowlist.
create table if not exists broker_accounts (
  id uuid primary key default gen_random_uuid(),
  broker text not null,                 -- 'robinhood' | 'kite' | 'alpaca'
  market text not null check (market in ('us','india')),
  account_number text not null,
  label text,
  role text not null default 'view_only' check (role in ('trading','view_only')),
  created_at timestamptz not null default now(),
  unique (broker, account_number)
);
alter table broker_accounts enable row level security;
revoke all on table broker_accounts from anon, authenticated;

-- Seed today's hardcoded accounts so behavior is unchanged on migration day.
insert into broker_accounts (broker, market, account_number, label, role) values
  ('robinhood','us','605420660','Robinhood Trading (agentic orders)','trading'),
  ('robinhood','us','965848641','Robinhood Trading (read-only positions)','view_only')
on conflict (broker, account_number) do nothing;

-- Per-market active trading account (defaults to today's hardcoded values).
alter table strategy_config add column if not exists active_account_us text default '605420660';
alter table strategy_config add column if not exists active_account_india text;

-- Which pipeline is authoritative for the live-account snapshot refresh.
alter table strategy_config add column if not exists live_account_source text default 'claude_exec'
  check (live_account_source in ('claude_exec','robinhood_mcp'));

-- Dedicated fast kill switch for the Robinhood MCP integration — default OFF.
alter table strategy_config add column if not exists robinhood_mcp_enabled boolean not null default false;

-- Hard absolute notional ceiling per order, enforced at the Gateway (live env).
-- Null → the Gateway computes a fraction of live equity instead.
alter table strategy_config add column if not exists max_order_notional numeric;
