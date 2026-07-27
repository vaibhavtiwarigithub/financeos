-- Historical allocation replay is a service-only, append-only research ledger.
-- It cannot update policy targets/status, touch paper positions, or enter any
-- execution path. Each row preserves the exact cached-price/config fingerprint.

create table if not exists public.international_allocation_replay_runs (
  id uuid primary key default gen_random_uuid(),
  policy_id uuid not null references public.international_allocation_policies(id) on delete restrict,
  created_at timestamptz not null default now(),
  status text not null check (status in ('completed', 'insufficient_history')),
  source_start_date date,
  source_end_date date,
  matched_sessions integer not null check (matched_sessions >= 0),
  configuration jsonb not null check (jsonb_typeof(configuration) = 'object'),
  source_data_fingerprint text not null,
  result jsonb not null check (jsonb_typeof(result) = 'object'),
  check (source_start_date is null or source_end_date is null or source_start_date <= source_end_date)
);

create index if not exists international_allocation_replay_runs_policy_created_idx
  on public.international_allocation_replay_runs (policy_id, created_at desc);

alter table public.international_allocation_replay_runs enable row level security;
revoke all on table public.international_allocation_replay_runs from public, anon, authenticated;

drop trigger if exists international_allocation_replay_runs_append_only on public.international_allocation_replay_runs;
create trigger international_allocation_replay_runs_append_only
before update or delete on public.international_allocation_replay_runs
for each row execute function public.reject_international_allocation_history_mutation();
