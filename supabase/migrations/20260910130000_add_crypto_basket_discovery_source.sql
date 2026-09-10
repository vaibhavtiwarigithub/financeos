-- Allow the Crypto Watch admission source in the immutable run ledger.
--
-- THE DEFECT THIS FIXES. Crypto Watch Stage 2 (2026-09-04) started feeding a
-- fixed BTC/ETH/SOL basket into every US research run, tagged
-- discovery_source='crypto_basket' (lib/research-agent.ts). That value was
-- never added to this constraint, so the ledger insert raised
--   new row for relation "discovery_snapshot_members" violates check
--   constraint "discovery_snapshot_members_discovery_source_check"
--
-- All members of a run are written in ONE insert, so the violation discarded
-- the WHOLE batch: every US research run since 2026-09-04 recorded no discovery
-- provenance at all, not merely the three crypto rows. The research itself was
-- unaffected (the ledger is audit-only and fail-soft), but Miss Review could not
-- reconstruct which symbols were admitted or why, which is exactly the question
-- the ledger exists to answer. Surfaced as the recurring warn
-- `research-discovery-ledger:us`.
--
-- Adding a discovery source in code without extending this constraint has now
-- happened twice (edge_relative_strength needed the same follow-up migration on
-- 2026-08-01). Any new SymbolEntry.discovery_source value MUST ship with a
-- matching migration in the same change.
alter table public.discovery_snapshot_members
  drop constraint if exists discovery_snapshot_members_discovery_source_check;

alter table public.discovery_snapshot_members
  add constraint discovery_snapshot_members_discovery_source_check check (discovery_source in (
    'holding', 'watchlist', 'screener_momentum', 'screener_value',
    'metals_basket', 'region_etf', 'india_holding', 'india_screener',
    'edge_relative_strength', 'crypto_basket', 'manual'
  ));
