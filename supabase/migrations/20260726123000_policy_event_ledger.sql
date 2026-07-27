-- US FOMC event evidence. This is record-only and is intentionally not read by
-- scoring, sizing, PaperTrader, PositionMonitor, or any live broker path.
create table if not exists public.policy_rate_events (
  id uuid primary key default gen_random_uuid(),
  market text not null check (market = 'us'),
  authority text not null check (authority = 'fomc'),
  scheduled_date date not null,
  status text not null default 'scheduled' check (status in ('scheduled', 'decided')),
  official_source_url text not null,
  actual_effective_date date,
  actual_target_lower numeric,
  actual_target_upper numeric,
  actual_source text,
  surprise_bps numeric,
  decided_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (authority, scheduled_date),
  check ((status = 'scheduled' and actual_target_lower is null and actual_target_upper is null)
      or (status = 'decided' and actual_target_lower is not null and actual_target_upper is not null
          and actual_target_lower <= actual_target_upper and actual_effective_date is not null))
);

create table if not exists public.policy_rate_expectation_snapshots (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null references public.policy_rate_events(id) on delete restrict,
  captured_at timestamptz not null,
  expected_target_lower numeric not null,
  expected_target_upper numeric not null,
  source_name text not null,
  source_url text not null,
  source_fingerprint text not null,
  created_at timestamptz not null default now(),
  check (expected_target_lower <= expected_target_upper),
  unique (event_id, source_name, source_fingerprint)
);

create table if not exists public.policy_event_impacts (
  id bigserial primary key,
  event_id uuid not null references public.policy_rate_events(id) on delete restrict,
  symbol text not null,
  benchmark_symbol text not null default 'SPY',
  horizon_sessions integer not null check (horizon_sessions in (1, 5)),
  first_session_date date not null,
  last_session_date date not null,
  symbol_return_pct numeric not null,
  benchmark_return_pct numeric,
  excess_return_pct numeric,
  symbol_price_basis text not null check (symbol_price_basis in ('adjusted_close', 'raw_close')),
  benchmark_price_basis text,
  source_fingerprint text not null,
  available_at timestamptz not null,
  created_at timestamptz not null default now(),
  check (first_session_date <= last_session_date),
  check ((benchmark_return_pct is null and excess_return_pct is null)
      or (benchmark_return_pct is not null and excess_return_pct is not null)),
  unique (event_id, symbol, horizon_sessions, source_fingerprint)
);

create index if not exists policy_rate_events_schedule_idx
  on public.policy_rate_events (scheduled_date desc);
create index if not exists policy_rate_expectation_event_captured_idx
  on public.policy_rate_expectation_snapshots (event_id, captured_at desc);
create index if not exists policy_event_impacts_event_horizon_idx
  on public.policy_event_impacts (event_id, horizon_sessions, created_at desc);

create or replace function public.policy_expectation_must_precede_decision()
returns trigger language plpgsql set search_path = '' as $$
declare cutoff timestamptz;
begin
  select ((scheduled_date::timestamp + time '14:00') at time zone 'America/New_York')
    into cutoff
    from public.policy_rate_events where id = new.event_id;
  if cutoff is null or new.captured_at >= cutoff then
    raise exception 'policy expectation must be captured before the scheduled FOMC decision';
  end if;
  return new;
end;
$$;
drop trigger if exists policy_expectation_predecision on public.policy_rate_expectation_snapshots;
create trigger policy_expectation_predecision
  before insert on public.policy_rate_expectation_snapshots
  for each row execute function public.policy_expectation_must_precede_decision();

create or replace function public.policy_event_impacts_immutable()
returns trigger language plpgsql set search_path = '' as $$
begin
  raise exception 'policy_event_impacts is append-only evidence';
end;
$$;
drop trigger if exists policy_event_impacts_no_mutation on public.policy_event_impacts;
create trigger policy_event_impacts_no_mutation
  before update or delete on public.policy_event_impacts
  for each row execute function public.policy_event_impacts_immutable();

alter table public.policy_rate_events enable row level security;
alter table public.policy_rate_expectation_snapshots enable row level security;
alter table public.policy_event_impacts enable row level security;
revoke all on public.policy_rate_events, public.policy_rate_expectation_snapshots, public.policy_event_impacts from public, anon, authenticated;
grant select, insert, update on public.policy_rate_events to service_role;
grant select, insert on public.policy_rate_expectation_snapshots to service_role;
grant select, insert on public.policy_event_impacts to service_role;
grant usage, select on sequence public.policy_event_impacts_id_seq to service_role;
revoke execute on function public.policy_expectation_must_precede_decision() from public, anon, authenticated;
revoke execute on function public.policy_event_impacts_immutable() from public, anon, authenticated;

comment on table public.policy_rate_events is
  'US FOMC schedule and official target-range outcomes. Record-only; no money-path reader.';
comment on table public.policy_rate_expectation_snapshots is
  'Immutable pre-decision expectation snapshots. No provider is enabled until licensed.';
comment on table public.policy_event_impacts is
  'Append-only post-FOMC impacts from frozen symbol_daily_returns evidence.';

do $$
begin
  perform cron.unschedule('kairos-policy-events');
exception when others then null;
end $$;
select cron.schedule(
  'kairos-policy-events', '0 23 * * 1-5',
  $$select public.kairos_call_agent('/api/agents/policy-events', '{}'::jsonb, 'POST', 55000)$$
);
