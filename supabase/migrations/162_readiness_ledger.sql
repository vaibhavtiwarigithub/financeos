-- 162: Append-only daily readiness evidence and human-controlled canary gates.
create table if not exists public.readiness_controls (
  id boolean primary key default true check (id),
  robinhood_canary_verified boolean not null default false,
  kite_canary_verified boolean not null default false,
  updated_at timestamptz not null default now()
);
insert into public.readiness_controls(id) values(true) on conflict(id) do nothing;
alter table public.readiness_controls enable row level security;
create policy readiness_controls_service on public.readiness_controls for all to service_role using(true) with check(true);
create policy readiness_controls_owner_read on public.readiness_controls for select to authenticated using(true);

create table if not exists public.readiness_runs (
  id bigserial primary key,
  checked_at timestamptz not null default now(),
  engineering_score numeric(5,2) not null,
  autonomous_score numeric(5,2) not null,
  engineering_ready boolean not null,
  autonomous_ready boolean not null,
  checks jsonb not null,
  blockers text[] not null default '{}'
);
alter table public.readiness_runs enable row level security;
create policy readiness_runs_service on public.readiness_runs for all to service_role using(true) with check(true);
create policy readiness_runs_owner_read on public.readiness_runs for select to authenticated using(true);
create index if not exists readiness_runs_checked_idx on public.readiness_runs(checked_at desc);

create or replace function public.readiness_runs_immutable() returns trigger
language plpgsql set search_path = public, pg_temp as $$ begin
  raise exception 'readiness_runs is append-only';
end; $$;
drop trigger if exists readiness_runs_no_update on public.readiness_runs;
create trigger readiness_runs_no_update before update or delete on public.readiness_runs
for each row execute function public.readiness_runs_immutable();

do $$ begin
  begin perform cron.unschedule('kairos-readiness-check'); exception when others then null; end;
end $$;
select cron.schedule('kairos-readiness-check','30 23 * * 1-5',
  $$select public.kairos_call_agent('/api/admin/readiness','{}'::jsonb,'POST',60000)$$);
