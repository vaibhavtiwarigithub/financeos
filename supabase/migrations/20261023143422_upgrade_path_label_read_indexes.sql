-- Support actual Upgrade Path / health watermark and bounded h10 read shapes.
-- Version matches the production migration runner's applied record.
-- pg_stat_statements showed these unindexed sorts/scans nearing the 8s timeout.
create index if not exists observation_labels_matured_at_desc_idx
  on public.observation_labels (matured_at desc);
create index if not exists observation_labels_horizon_id_idx
  on public.observation_labels (horizon_days, id);
analyze public.observation_labels;
