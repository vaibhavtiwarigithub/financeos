-- Allow one selected baseline model or a 2–5 model research council.
-- Execution remains OFF by default and shadow-only; this changes configuration
-- capacity, not any scoring or trading consumer.
alter table public.llm_council_config
  drop constraint if exists llm_council_config_participant_models_check;

alter table public.llm_council_config
  add constraint llm_council_config_participant_models_check
  check (cardinality(participant_models) between 1 and 5);
