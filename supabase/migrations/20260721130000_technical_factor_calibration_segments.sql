-- Reusable technical-factor calibration identities.
-- Measure-only: no scoring, mandate, position, cash, proposal, or order table is touched.

alter table public.edge_ic_history
  add column if not exists segment_type text,
  add column if not exists segment_value text,
  add column if not exists formula_version text,
  add column if not exists dataset_fingerprint text,
  add column if not exists run_fingerprint text;

update public.edge_ic_history
set segment_type = coalesce(segment_type, 'market'),
    segment_value = coalesce(segment_value, 'all'),
    formula_version = coalesce(formula_version, edge_id),
    dataset_fingerprint = coalesce(dataset_fingerprint, 'legacy_unverified'),
    run_fingerprint = coalesce(run_fingerprint, 'legacy:' || id::text)
where segment_type is null
   or segment_value is null
   or formula_version is null
   or dataset_fingerprint is null
   or run_fingerprint is null;

alter table public.edge_ic_history
  alter column segment_type set not null,
  alter column segment_value set not null,
  alter column formula_version set not null,
  alter column dataset_fingerprint set not null,
  alter column run_fingerprint set not null;

alter table public.edge_ic_history
  drop constraint if exists edge_ic_history_edge_id_market_window_end_horizon_key,
  drop constraint if exists edge_ic_history_segment_type_ck,
  add constraint edge_ic_history_segment_type_ck
    check (segment_type in ('market', 'sector')),
  drop constraint if exists edge_ic_history_segment_value_ck,
  add constraint edge_ic_history_segment_value_ck
    check (length(btrim(segment_value)) between 1 and 80),
  drop constraint if exists edge_ic_history_fingerprint_ck,
  add constraint edge_ic_history_fingerprint_ck
    check (length(run_fingerprint) between 8 and 128);

create unique index if not exists edge_ic_history_run_fingerprint_uidx
  on public.edge_ic_history (run_fingerprint);

create index if not exists edge_ic_history_segment_lookup_idx
  on public.edge_ic_history
    (edge_id, market, segment_type, segment_value, horizon, window_end desc);

create or replace function public.edge_ic_history_block_mutation()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception 'edge_ic_history is append-only; insert a new run fingerprint';
end;
$$;

drop trigger if exists edge_ic_history_no_mutation on public.edge_ic_history;
create trigger edge_ic_history_no_mutation
  before update or delete on public.edge_ic_history
  for each row execute function public.edge_ic_history_block_mutation();

revoke execute on function public.edge_ic_history_block_mutation() from public, anon, authenticated;

comment on table public.edge_ic_history is
  'Append-only market/sector factor diagnostics. Measure-only; never a score or trading authority.';
comment on column public.edge_ic_history.run_fingerprint is
  'Stable identity over formula, market, segment, horizon, dataset fingerprint, and run configuration.';
