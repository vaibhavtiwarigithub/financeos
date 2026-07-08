-- Agent Evolution: discovery_source attribution on decision_observations.
-- Records how each symbol entered the research batch so LearnerAgent can
-- correlate pipeline performance with discovery path (e.g., "screener_momentum
-- picks close 12% higher than watchlist picks on average over 30 days").
-- Additive column; no existing data affected. NULL = legacy rows (before 2026-07-08).

alter table decision_observations
  add column if not exists discovery_source text;

comment on column decision_observations.discovery_source is
  'How this symbol entered the research batch: holding | watchlist | screener_momentum | screener_value | metals_basket | region_etf | india_holding | india_screener | manual. NULL for rows written before this migration.';

create index if not exists idx_decision_observations_discovery_source
  on decision_observations (discovery_source)
  where discovery_source is not null;
