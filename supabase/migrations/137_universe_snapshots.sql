-- Scoring P1: universe snapshot tables.
-- Purpose: record the PIT universe for each research run so cross-sectional
-- ranks can be computed and queried. No change to paper/live selection.
-- decision_observations.universe_snapshot_id (added in 136) references these rows.

create table if not exists public.universe_snapshots (
  id              bigint generated always as identity primary key,
  run_id          text,                         -- agent_runs.id that triggered this snapshot
  market          text not null,
  source          text,                         -- 'screener' | 'holdings' | 'watchlist' | 'mixed'
  symbol_count    int,
  symbols         text[],                       -- all symbols in the universe for this run
  snapshot_ts     timestamptz not null default now(),
  created_at      timestamptz not null default now()
);

create index if not exists idx_universe_snapshots_market_ts
  on public.universe_snapshots(market, snapshot_ts desc);

-- Cross-sectional rank per symbol within a universe snapshot.
-- Append-only by convention. rank_pct = percentile(0–1) of analyst_score within the snapshot.
-- decision_observations.universe_snapshot_id → universe_snapshots.id (soft FK; no hard FK
-- because decision_observations has an append-only mutation-blocking trigger and we want to
-- avoid FK violations during test/backfill scenarios).
create table if not exists public.universe_snapshot_scores (
  id                    bigint generated always as identity primary key,
  universe_snapshot_id  bigint not null references public.universe_snapshots(id),
  symbol                text not null,
  analyst_score         numeric,
  rank_pct              numeric check (rank_pct >= 0 and rank_pct <= 1),
  decision_observation_id bigint,              -- nullable back-reference (not enforced FK)
  created_at            timestamptz not null default now(),
  unique (universe_snapshot_id, symbol)
);

create index if not exists idx_universe_snapshot_scores_snapshot
  on public.universe_snapshot_scores(universe_snapshot_id);
