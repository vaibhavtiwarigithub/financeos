-- Observation labels are published outcomes. Corrections use a new contract
-- version/new observation; an existing label must never be silently rewritten.
create or replace function public.reject_observation_label_mutation()
returns trigger
language plpgsql
set search_path = pg_catalog, public
as $$
begin
  raise exception 'observation_labels are append-only; insert a new contract version instead'
    using errcode = '55000';
end;
$$;

drop trigger if exists observation_labels_append_only on public.observation_labels;
create trigger observation_labels_append_only
before update or delete on public.observation_labels
for each row execute function public.reject_observation_label_mutation();

comment on function public.reject_observation_label_mutation() is
  'Prevents rewriting published forward outcomes; new label contracts are append-only.';
