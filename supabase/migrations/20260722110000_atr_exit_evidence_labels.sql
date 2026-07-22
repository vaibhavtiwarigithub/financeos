-- Measure-only ATR exit evidence. These columns are derived label truth and
-- have no trigger, RPC, or foreign key into paper/live execution state.

alter table public.observation_labels
  add column if not exists entry_atr numeric,
  add column if not exists entry_atr_pct numeric,
  add column if not exists max_adverse_excursion_atr numeric,
  add column if not exists max_favorable_excursion_atr numeric,
  add column if not exists atr_exit_outcomes jsonb,
  add column if not exists atr_policy_version text;

alter table public.observation_labels
  drop constraint if exists observation_labels_entry_atr_check,
  add constraint observation_labels_entry_atr_check
    check (entry_atr is null or entry_atr > 0),
  drop constraint if exists observation_labels_entry_atr_pct_check,
  add constraint observation_labels_entry_atr_pct_check
    check (entry_atr_pct is null or entry_atr_pct > 0),
  drop constraint if exists observation_labels_atr_pair_check,
  add constraint observation_labels_atr_pair_check check (
    (entry_atr is null and entry_atr_pct is null
      and max_adverse_excursion_atr is null
      and max_favorable_excursion_atr is null
      and atr_exit_outcomes is null)
    or
    (entry_atr is not null and entry_atr_pct is not null
      and max_adverse_excursion_atr is not null
      and max_favorable_excursion_atr is not null
      and jsonb_typeof(atr_exit_outcomes) = 'array')
  );

comment on column public.observation_labels.atr_exit_outcomes is
  'Measure-only close-observed candidate outcomes. Never read by a trading or exit path.';
comment on column public.observation_labels.atr_policy_version is
  'Version of the deterministic candidate family used to derive atr_exit_outcomes.';
