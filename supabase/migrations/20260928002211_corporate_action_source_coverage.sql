-- Record whether corporate-action history was actually fetched and validated.
-- An empty event table is not evidence that a symbol has no splits/dividends.
create table if not exists public.corporate_action_source_coverage (
  id uuid primary key default gen_random_uuid(),
  symbol text not null,
  action_type text not null check (action_type in ('split', 'dividend')),
  source text not null,
  status text not null check (status in ('complete', 'invalid', 'stale', 'error')),
  checked_at timestamptz not null default now(),
  provider_fetched_at timestamptz,
  records_count integer not null default 0 check (records_count >= 0),
  details jsonb not null default '{}'::jsonb
);

create index if not exists corporate_action_coverage_latest_idx
  on public.corporate_action_source_coverage (symbol, action_type, checked_at desc, id desc);

alter table public.corporate_action_source_coverage enable row level security;
revoke all on public.corporate_action_source_coverage from public, anon, authenticated;
grant select on public.corporate_action_source_coverage to authenticated;
grant select, insert on public.corporate_action_source_coverage to service_role;

drop policy if exists corporate_action_coverage_owner_read on public.corporate_action_source_coverage;
create policy corporate_action_coverage_owner_read
  on public.corporate_action_source_coverage for select to authenticated
  using ((select auth.jwt() ->> 'email') = 'vterminater@gmail.com');

comment on table public.corporate_action_source_coverage is
  'Append-only source coverage evidence; complete with zero records means a validated empty response, unlike missing coverage.';
