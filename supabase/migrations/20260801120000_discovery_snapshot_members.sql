-- Run-level ResearchAgent admission provenance. This table is audit-only and is
-- read by no scoring, paper, live, or order path.

create table if not exists public.discovery_snapshot_members (
  id bigint generated always as identity primary key,
  universe_snapshot_id bigint not null references public.universe_snapshots(id),
  market text not null check (market in ('us', 'india')),
  symbol text not null,
  discovery_source text not null check (discovery_source in (
    'holding', 'watchlist', 'screener_momentum', 'screener_value',
    'metals_basket', 'region_etf', 'india_holding', 'india_screener', 'manual'
  )),
  is_held boolean not null,
  is_etf boolean not null,
  asset_class text,
  screener_bucket text check (screener_bucket in ('momentum', 'value')),
  created_at timestamptz not null default now(),
  unique (universe_snapshot_id, symbol),
  check ((market = 'india' and asset_class = 'india') or market = 'us' or asset_class is null)
);

create index if not exists discovery_snapshot_members_market_symbol_idx
  on public.discovery_snapshot_members (market, symbol, created_at desc);
create index if not exists discovery_snapshot_members_snapshot_idx
  on public.discovery_snapshot_members (universe_snapshot_id);

create or replace function public.discovery_snapshot_members_append_only()
returns trigger language plpgsql as $$
begin
  raise exception 'discovery_snapshot_members is append-only';
end;
$$;

drop trigger if exists discovery_snapshot_members_no_mutation on public.discovery_snapshot_members;
create trigger discovery_snapshot_members_no_mutation
  before update or delete on public.discovery_snapshot_members
  for each row execute function public.discovery_snapshot_members_append_only();

alter table public.discovery_snapshot_members enable row level security;
revoke all on public.discovery_snapshot_members from anon, authenticated;
revoke all on sequence public.discovery_snapshot_members_id_seq from anon, authenticated;

drop policy if exists discovery_snapshot_members_service_all on public.discovery_snapshot_members;
create policy discovery_snapshot_members_service_all
  on public.discovery_snapshot_members
  for all to service_role using (true) with check (true);

comment on table public.discovery_snapshot_members is
  'Append-only ResearchAgent batch-admission provenance. Audit-only; no scoring, paper, live, or order path reads this table.';
