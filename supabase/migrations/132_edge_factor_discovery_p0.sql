-- 132 — Edge/Factor Discovery P0 (MEASURE-ONLY). Additive only.
--
-- Backing store for the deterministic edge/factor library (see
-- features/edge-factor-discovery/). P0 is measure-only: nothing here feeds
-- analyst_score, agent_signals, paper fills, sizing, or any live-money path.
-- These are read-heavy analytics tables. RLS is enabled with NO policies
-- (deny-by-default to anon/authenticated); the service-role client used by the
-- edge-scout job and the owner-gated read API bypasses RLS.
--
-- HONESTY NOTE: edge_universe_members records the exact symbol set used for a
-- run. P0 does NOT claim true point-in-time index membership — the universe is a
-- current-liquid snapshot, and that limitation is labeled in the UI/reporting.

-- 1) Catalog of edges (formula metadata; not the values).
create table if not exists public.edge_catalog (
  edge_id        text primary key,
  name           text not null,
  category       text not null,
  formula_spec   text,
  inputs         jsonb default '[]'::jsonb,
  rationale      text,
  expected_sign  integer default 1,          -- +1 higher=better, -1 lower=better
  horizon_days   integer default 20,
  data_source    text,
  reference_urls jsonb default '[]'::jsonb,   -- 'references' is reserved; use this
  status         text not null default 'candidate',
  created_at     timestamptz not null default now()
);

-- 2) The exact eligible universe used for a run (survivorship-honest audit).
create table if not exists public.edge_universe_members (
  id              bigint generated always as identity primary key,
  universe_id     text not null,
  market          text not null,
  symbol          text not null,
  as_of_date      date not null,
  source          text,                       -- watchlist | us_screener | india_screen_cache | manual
  included_reason text,
  created_at      timestamptz not null default now(),
  unique (universe_id, market, symbol)
);
create index if not exists idx_edge_universe_members_uid on public.edge_universe_members (universe_id, market);

-- 3) Computed edge signals per (symbol, date, edge, market). z_value is the
--    cross-sectional standardized value within (date, market, edge).
create table if not exists public.edge_signals (
  id          bigint generated always as identity primary key,
  symbol      text not null,
  date        date not null,
  edge_id     text not null references public.edge_catalog(edge_id),
  market      text not null,
  raw_value   numeric,
  z_value     numeric,
  universe_id text,
  created_at  timestamptz not null default now(),
  unique (symbol, date, edge_id, market)
);
create index if not exists idx_edge_signals_date_market_edge on public.edge_signals (date, market, edge_id);

-- 4) Point-in-time input audit — proves WHEN the app could have known each input.
--    No edge may be promoted (later phases) if its inputs can't prove availability.
create table if not exists public.edge_signal_inputs (
  id                bigint generated always as identity primary key,
  edge_signal_id    bigint not null references public.edge_signals(id) on delete cascade,
  input_name        text not null,
  source            text,
  as_of_date        date,
  available_at      timestamptz,
  revised_at        timestamptz,
  adjustment_policy text,                      -- e.g. 'split+div adjusted close'
  raw_ref           text,
  unique (edge_signal_id, input_name, source, as_of_date)
);
create index if not exists idx_edge_signal_inputs_sig on public.edge_signal_inputs (edge_signal_id);

-- 5) IC history — created here, POPULATED IN P1 (rolling IC/IR/t-stat/decay).
create table if not exists public.edge_ic_history (
  id             bigint generated always as identity primary key,
  edge_id        text not null,
  market         text not null,
  window_end     date not null,
  ic             numeric,
  ic_ir          numeric,
  t_stat         numeric,
  horizon        integer,
  net_of_fee_ic  numeric,
  turnover       numeric,
  status_after   text,
  created_at     timestamptz not null default now(),
  unique (edge_id, market, window_end, horizon)
);

-- RLS: deny-by-default (no policies); service role bypasses.
alter table public.edge_catalog        enable row level security;
alter table public.edge_universe_members enable row level security;
alter table public.edge_signals        enable row level security;
alter table public.edge_signal_inputs  enable row level security;
alter table public.edge_ic_history      enable row level security;
