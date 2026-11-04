-- Structured, append-only election/policy context and sourced per-symbol exposure.
-- Measure-only: no score, paper, live, sizing, exit, or execution reader.

alter table public.market_events
  add column if not exists event_context_version integer not null default 1;

alter table public.market_event_outcomes
  add column if not exists input_fingerprint text,
  add column if not exists matched_control_mean numeric,
  add column if not exists matched_control_n integer not null default 0 check (matched_control_n >= 0),
  add column if not exists matched_control_delta numeric,
  add column if not exists forward_volatility numeric,
  add column if not exists max_drawdown numeric,
  add column if not exists matching_method text not null default 'none';

create table if not exists public.market_policy_event_context (
  event_id bigint primary key references public.market_events(id) on delete restrict,
  policy_chain_id uuid not null,
  family text not null check (family in ('election', 'federal_policy')),
  stage_status text not null check (stage_status in (
    'projected', 'called', 'certified', 'proposed', 'passed', 'signed',
    'effective', 'blocked', 'reversed'
  )),
  policy_domain text check (policy_domain in (
    'tax', 'trade', 'energy', 'health', 'defense', 'antitrust',
    'industrial_subsidy', 'other'
  )),
  chamber text check (chamber in ('house', 'senate', 'presidency')),
  previous_control text check (previous_control in ('democratic', 'republican', 'split', 'tie', 'unknown')),
  resulting_control text check (resulting_control in ('democratic', 'republican', 'split', 'tie', 'unknown')),
  event_title text not null check (length(trim(event_title)) between 1 and 240),
  source_evidence text not null check (length(trim(source_evidence)) between 10 and 1200),
  source_snapshot_hash text not null check (source_snapshot_hash ~ '^[0-9a-f]{64}$'),
  observed_at timestamptz not null default now(),
  check (
    (family = 'election' and policy_domain is null and chamber is not null
      and previous_control is not null and resulting_control is not null
      and stage_status in ('projected', 'called', 'certified'))
    or
    (family = 'federal_policy' and policy_domain is not null and chamber is null
      and previous_control is null and resulting_control is null
      and stage_status in ('proposed', 'passed', 'signed', 'effective', 'blocked', 'reversed'))
  )
);

create index if not exists market_policy_event_context_chain_idx
  on public.market_policy_event_context (policy_chain_id, observed_at desc);

create table if not exists public.market_policy_event_exposures (
  event_id bigint not null references public.market_policy_event_context(event_id) on delete restrict,
  symbol text not null check (symbol = upper(trim(symbol)) and length(symbol) between 1 and 24),
  exposure_stance text not null check (exposure_stance in ('positive', 'negative', 'mixed', 'unknown')),
  rationale text not null check (length(trim(rationale)) between 1 and 500),
  source_name text not null check (length(trim(source_name)) between 1 and 120),
  source_url text not null check (source_url ~ '^https?://'),
  source_published_at timestamptz not null,
  observed_at timestamptz not null default now(),
  primary key (event_id, symbol)
);

create or replace function public.market_policy_exposure_precedes_event()
returns trigger language plpgsql set search_path = '' as $$
declare v_occurred_at timestamptz;
begin
  select e.occurred_at into v_occurred_at
    from public.market_events e where e.id = new.event_id;
  if v_occurred_at is null or new.source_published_at > v_occurred_at then
    raise exception 'company exposure evidence must be public no later than the policy event';
  end if;
  return new;
end;
$$;

drop trigger if exists market_policy_exposure_precedes_event on public.market_policy_event_exposures;
create trigger market_policy_exposure_precedes_event
  before insert on public.market_policy_event_exposures
  for each row execute function public.market_policy_exposure_precedes_event();

create or replace function public.market_policy_context_immutable()
returns trigger language plpgsql set search_path = '' as $$
begin
  raise exception 'market event evidence is append-only';
end;
$$;

-- Protect the parent event timestamp/source too: changing it would silently
-- change which stored market sessions count as post-event outcomes.
create or replace function public.market_policy_event_parent_immutable()
returns trigger language plpgsql set search_path = '' as $$
begin
  if tg_op = 'TRUNCATE' then
    if exists (
      select 1 from public.market_events
      where event_type in ('election_control_change', 'federal_policy_action')
    ) then
      raise exception 'market policy event evidence is append-only';
    end if;
    return null;
  end if;
  if old.event_type in ('election_control_change', 'federal_policy_action') then
    raise exception 'market policy event evidence is append-only';
  end if;
  if tg_op = 'DELETE' then return old; end if;
  return new;
end;
$$;
drop trigger if exists market_policy_event_parent_no_mutation on public.market_events;
create trigger market_policy_event_parent_no_mutation
  before update or delete on public.market_events
  for each row execute function public.market_policy_event_parent_immutable();
drop trigger if exists market_policy_event_parent_no_truncate on public.market_events;
create trigger market_policy_event_parent_no_truncate
  before truncate on public.market_events
  for each statement execute function public.market_policy_event_parent_immutable();
drop trigger if exists market_policy_context_no_mutation on public.market_policy_event_context;
create trigger market_policy_context_no_mutation
  before update or delete on public.market_policy_event_context
  for each row execute function public.market_policy_context_immutable();
drop trigger if exists market_policy_context_no_truncate on public.market_policy_event_context;
create trigger market_policy_context_no_truncate
  before truncate on public.market_policy_event_context
  for each statement execute function public.market_policy_context_immutable();

drop trigger if exists market_policy_exposure_no_mutation on public.market_policy_event_exposures;
create trigger market_policy_exposure_no_mutation
  before update or delete on public.market_policy_event_exposures
  for each row execute function public.market_policy_context_immutable();
drop trigger if exists market_policy_exposure_no_truncate on public.market_policy_event_exposures;
create trigger market_policy_exposure_no_truncate
  before truncate on public.market_policy_event_exposures
  for each statement execute function public.market_policy_context_immutable();

drop trigger if exists market_event_outcomes_no_mutation on public.market_event_outcomes;
create trigger market_event_outcomes_no_mutation
  before update or delete on public.market_event_outcomes
  for each row execute function public.market_policy_context_immutable();
drop trigger if exists market_event_outcomes_no_truncate on public.market_event_outcomes;
create trigger market_event_outcomes_no_truncate
  before truncate on public.market_event_outcomes
  for each statement execute function public.market_policy_context_immutable();

-- One event may have many exposed symbols, so make outcome identity include the
-- subject symbol. Existing rows remain intact; null subjects still dedupe.
alter table public.market_event_outcomes
  drop constraint if exists market_event_outcomes_event_id_horizon_days_benchmark_symbo_key;
create unique index if not exists market_event_outcomes_event_horizon_benchmark_subject_key
  on public.market_event_outcomes (event_id, horizon_days, benchmark_symbol, subject_symbol) nulls not distinct;

create or replace function public.record_market_policy_event(
  p_event jsonb,
  p_context jsonb,
  p_exposures jsonb
) returns bigint
language plpgsql security definer set search_path = '' as $$
declare
  v_event_id bigint;
  v_observed_at timestamptz := now();
  v_event_type text;
  v_item jsonb;
begin
  if jsonb_typeof(p_event) <> 'object' or jsonb_typeof(p_context) <> 'object'
     or jsonb_typeof(p_exposures) <> 'array' or jsonb_array_length(p_exposures) > 50 then
    raise exception 'invalid policy event payload';
  end if;
  if p_event->>'market' <> 'us' or p_event->>'symbol' is not null then
    raise exception 'policy impact shadow currently accepts US market-wide events only';
  end if;
  v_event_type := p_event->>'event_type';
  if v_event_type not in ('election_control_change', 'federal_policy_action') then
    raise exception 'unsupported policy event type';
  end if;

  insert into public.market_events (
    event_type, occurred_at, observed_at, market, direction, magnitude,
    source_url, source_name, notes, symbol, event_context_version
  ) values (
    v_event_type, (p_event->>'occurred_at')::timestamptz, v_observed_at,
    'us', p_event->>'direction', nullif(p_event->>'magnitude', '')::numeric,
    p_event->>'source_url', p_event->>'source_name', p_event->>'notes', null, 1
  ) returning id into v_event_id;

  insert into public.market_policy_event_context (
    event_id, policy_chain_id, family, stage_status, policy_domain, chamber,
    previous_control, resulting_control, event_title, source_evidence, source_snapshot_hash, observed_at
  ) values (
    v_event_id, (p_context->>'policy_chain_id')::uuid, p_context->>'family',
    p_context->>'stage_status', nullif(p_context->>'policy_domain', ''),
    nullif(p_context->>'chamber', ''), nullif(p_context->>'previous_control', ''),
    nullif(p_context->>'resulting_control', ''), p_context->>'event_title', p_context->>'source_evidence',
    p_context->>'source_snapshot_hash', v_observed_at
  );

  for v_item in select value from jsonb_array_elements(p_exposures) loop
    insert into public.market_policy_event_exposures (
      event_id, symbol, exposure_stance, rationale, source_name, source_url,
      source_published_at, observed_at
    ) values (
      v_event_id, upper(trim(v_item->>'symbol')), v_item->>'exposure_stance',
      v_item->>'rationale', v_item->>'source_name', v_item->>'source_url',
      (v_item->>'source_published_at')::timestamptz, v_observed_at
    );
  end loop;
  return v_event_id;
end;
$$;

alter table public.market_policy_event_context enable row level security;
alter table public.market_policy_event_exposures enable row level security;
revoke all on public.market_policy_event_context, public.market_policy_event_exposures from public, anon, authenticated;
grant select, insert on public.market_policy_event_context to service_role;
grant select, insert on public.market_policy_event_exposures to service_role;
revoke update, delete, truncate on public.market_policy_event_context, public.market_policy_event_exposures from service_role;
revoke update, delete, truncate on public.market_event_outcomes from service_role;

revoke execute on function public.market_policy_exposure_precedes_event() from public, anon, authenticated;
revoke execute on function public.market_policy_context_immutable() from public, anon, authenticated;
revoke execute on function public.market_policy_event_parent_immutable() from public, anon, authenticated;
revoke all on function public.record_market_policy_event(jsonb, jsonb, jsonb) from public, anon, authenticated;
grant execute on function public.record_market_policy_event(jsonb, jsonb, jsonb) to service_role;

comment on table public.market_policy_event_context is
  'Append-only sourced US election and federal-policy event metadata. Measurement only; no money-path readers.';
comment on table public.market_policy_event_exposures is
  'Append-only symbol exposure classifications backed by evidence public before the event; not company recommendations.';
comment on function public.record_market_policy_event(jsonb, jsonb, jsonb) is
  'Atomic service-only append of an owner-verified policy event, structured context, and pre-event symbol exposure evidence.';

comment on index public.market_event_outcomes_event_horizon_benchmark_subject_key is
  'Allows one event outcome per exposed subject symbol and benchmark while preserving distinct same-event observations.';
