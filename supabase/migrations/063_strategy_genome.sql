-- Phase 3 learning-core: typed strategy genome. Extends strategy_versions with
-- a canonical, bounded manifest so evolution can touch more than the 5 top-
-- level weights — entry threshold, horizon, exit family, sizing mode, universe,
-- regime router. Absent genome = legacy scoring behavior, unchanged.

alter table strategy_versions add column if not exists genome jsonb;
alter table agent_signals add column if not exists genome_hash text;

comment on column strategy_versions.genome is
  'Canonical shape: {features:{included,transforms}, entry:{score_threshold,direction}, universe:{us,india,liquidity_min_dollar_vol}, horizon_days, exit:{family,stop_mae_pctile,target_mfe_pctile,trail}, sizing:{mode,cap_pct,floor_pct}, regime:{router}}. Search-domain bounds enforced in lib/validation/genome.ts, not the DB.';
