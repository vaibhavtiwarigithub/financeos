-- Migration 133: investment_mandates table
-- Mandate-aware evaluation layer (P0). Advisory only — NOT wired to broker gateway.

create table public.investment_mandates (
  id                       uuid primary key default gen_random_uuid(),
  name                     text not null,
  market                   text not null check (market in ('us', 'india')),
  horizon                  text not null check (horizon in (
                             'swing_2_20d', 'position_1_6m',
                             'long_term_1y_plus', 'income_dividend'
                           )),
  -- 'intraday' excluded: no intraday data/execution model
  benchmark_symbol         text not null,
  min_holding_days         int,
  max_holding_days         int,
  evaluation_horizon_days  int[] not null default array[5, 10, 20],
  -- Advisory sizing cap only. NOT consumed by broker gateway or live order path.
  max_position_pct         numeric not null default 10,
  turnover_budget_monthly  numeric,
  allowed_asset_types      text[] not null default array['equity', 'etf'],
  allowed_signal_families  text[] not null default array['momentum', 'quality', 'technical', 'sentiment', 'macro'],
  tax_sensitivity          text not null default 'medium'
                             check (tax_sensitivity in ('low', 'medium', 'high')),
  income_preference        text not null default 'none'
                             check (income_preference in ('none', 'dividend', 'growth')),
  execution_model          text not null default 'conservative_close'
                             check (execution_model in ('conservative_close', 'optimistic_close')),
  -- Review eligibility flag. ADVISORY ONLY.
  -- This column is NEVER read by broker adapters, gateway routes, or order placement code.
  -- Live orders always require owner-click gate via strategy_config + broker adapter.
  eligible_for_live_review boolean not null default false,
  mandate_version          int not null default 1,
  active                   boolean not null default true,
  archived_at              timestamptz,
  created_at               timestamptz not null default now()
);

alter table public.investment_mandates enable row level security;
-- Deny-by-default: all access via service-role routes (owner-gated API routes).
-- No direct client reads in P0.

-- Seed default mandates — map to existing swing behavior
insert into public.investment_mandates
  (name, market, horizon, benchmark_symbol, min_holding_days, max_holding_days)
values
  ('Swing US 2-20d',     'us',    'swing_2_20d', 'VOO',        2, 20),
  ('Swing India 2-20d',  'india', 'swing_2_20d', 'NIFTY50.NS', 2, 20);
