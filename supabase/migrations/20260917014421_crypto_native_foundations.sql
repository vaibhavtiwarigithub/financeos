-- Crypto-native foundation (Decision 78). These tables are deliberately
-- separate from equity strategy_versions and contain only evidence/shadow
-- state. They expose no order function and do not enable live crypto trading.

create table if not exists public.crypto_universe_runs (
  id uuid primary key default gen_random_uuid(),
  observed_at timestamptz not null default now(),
  source text not null,
  status text not null check (status in ('done','partial','error')),
  summary jsonb not null default '{}'::jsonb,
  error text
);

create table if not exists public.crypto_universe_members (
  run_id uuid not null references public.crypto_universe_runs(id) on delete cascade,
  symbol text not null,
  broker_tradeable boolean not null default false,
  account_eligible boolean not null default false,
  history_days integer,
  quote_observed_at timestamptz,
  bid numeric,
  ask numeric,
  spread_pct numeric,
  admitted boolean not null default false,
  refusal_reason text,
  raw jsonb not null default '{}'::jsonb,
  primary key (run_id, symbol),
  check (history_days is null or history_days >= 0),
  check (spread_pct is null or spread_pct >= 0)
);
create index if not exists crypto_universe_members_admitted_idx
  on public.crypto_universe_members(run_id, admitted, symbol);

create table if not exists public.crypto_strategy_versions (
  id uuid primary key default gen_random_uuid(),
  version text not null unique,
  state text not null check (state in ('draft','shadow','paper_candidate','paper_active','rejected','retired')),
  is_champion boolean not null default false,
  parameters jsonb not null,
  parent_id uuid references public.crypto_strategy_versions(id),
  created_at timestamptz not null default now(),
  promoted_at timestamptz,
  retired_at timestamptz,
  notes text,
  check ((not is_champion) or state = 'paper_active')
);
create unique index if not exists crypto_strategy_one_champion_idx
  on public.crypto_strategy_versions((is_champion)) where is_champion;

create table if not exists public.crypto_geometry_shadows (
  id uuid primary key default gen_random_uuid(),
  observed_at timestamptz not null default now(),
  signal_id bigint,
  symbol text not null,
  strategy_version text not null,
  entry_price numeric,
  quote_observed_at timestamptz,
  spread_pct numeric,
  geometry jsonb not null,
  decision text not null check (decision in ('eligible','refused')),
  refusal_reason text,
  input_fingerprint text not null,
  unique (symbol, strategy_version, input_fingerprint)
);
create index if not exists crypto_geometry_shadows_symbol_observed_idx
  on public.crypto_geometry_shadows(symbol, observed_at desc);

-- Owner can inspect the evidence. Writes remain service-role only; no browser
-- client receives permission to add strategy parameters or fabricate results.
do $$
declare table_name text;
begin
  foreach table_name in array array[
    'crypto_universe_runs', 'crypto_universe_members',
    'crypto_strategy_versions', 'crypto_geometry_shadows'
  ] loop
    execute format('alter table public.%I enable row level security', table_name);
    execute format('revoke all on table public.%I from anon', table_name);
    execute format('revoke insert, update, delete, truncate, references, trigger on table public.%I from authenticated', table_name);
    execute format('grant select on table public.%I to authenticated', table_name);
    execute format('drop policy if exists %I_owner_read on public.%I', table_name, table_name);
    execute format(
      'create policy %I_owner_read on public.%I for select to authenticated using (((select auth.jwt())->>''email'')=''vterminater@gmail.com'')',
      table_name, table_name
    );
  end loop;
end $$;
