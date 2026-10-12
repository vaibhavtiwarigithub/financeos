-- A rejected model reply may be repaired once. Give the repair its own audit row instead of colliding with the first attempt.
alter table public.llm_council_turns add column if not exists attempt smallint not null default 0;
alter table public.llm_council_turns drop constraint if exists llm_council_turns_attempt_check;
alter table public.llm_council_turns add constraint llm_council_turns_attempt_check check (attempt between 0 and 1);
alter table public.llm_council_turns drop constraint if exists llm_council_turns_run_id_model_requested_turn_role_round_key;
alter table public.llm_council_turns add constraint llm_council_turns_run_model_role_round_attempt_key unique (run_id, model_requested, turn_role, round, attempt);
