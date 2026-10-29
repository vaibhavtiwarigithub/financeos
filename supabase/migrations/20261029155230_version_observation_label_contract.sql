-- Distinguish previously published labels from the corrected immutable
-- decision-mark contract. Existing outcomes are classified as legacy; they are
-- never recalculated or rewritten by this migration.
alter table public.observation_labels
  add column if not exists label_contract_version text not null default 'legacy_v1',
  add column if not exists entry_price_as_of date,
  add column if not exists entry_price_source text;

alter table public.observation_labels
  drop constraint if exists observation_labels_contract_version_check,
  add constraint observation_labels_contract_version_check
    check (label_contract_version in ('legacy_v1', 'decision_mark_v2')),
  drop constraint if exists observation_labels_decision_mark_provenance_check,
  add constraint observation_labels_decision_mark_provenance_check
    check (
      label_contract_version <> 'decision_mark_v2'
      or (entry_price_as_of is not null and entry_price_source is not null and length(trim(entry_price_source)) > 0)
    );

create index if not exists observation_labels_contract_horizon_idx
  on public.observation_labels(label_contract_version, horizon_days, observation_id);

comment on column public.observation_labels.label_contract_version is
  'legacy_v1 rows retain their original immutable outcome; decision_mark_v2 uses only the frozen decision price and strictly later market sessions.';
comment on column public.observation_labels.entry_price_as_of is
  'Market-local completed session date for the frozen decision price; populated for decision_mark_v2 labels.';
comment on column public.observation_labels.entry_price_source is
  'Source recorded in the immutable decision observation trade_plan; populated for decision_mark_v2 labels.';
