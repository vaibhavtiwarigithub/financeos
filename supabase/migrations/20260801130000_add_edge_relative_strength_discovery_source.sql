-- Allow the candidate-only EdgeScout admission source in the immutable run ledger.
alter table public.discovery_snapshot_members
  drop constraint if exists discovery_snapshot_members_discovery_source_check;

alter table public.discovery_snapshot_members
  add constraint discovery_snapshot_members_discovery_source_check check (discovery_source in (
    'holding', 'watchlist', 'screener_momentum', 'screener_value',
    'metals_basket', 'region_etf', 'india_holding', 'india_screener',
    'edge_relative_strength', 'manual'
  ));
