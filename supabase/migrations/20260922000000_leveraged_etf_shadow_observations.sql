-- Leveraged long-ETF shadow (L1): immutable, measure-only observation store.
-- Backs app/api/agents/leveraged-etf-shadow/route.ts and
-- lib/trading/leveraged-etf-shadow.ts (LEVERAGED_ETF_SHADOW_POLICY_VERSION).
-- The route already handles a missing table (42P01 -> 503
-- leveraged_etf_shadow_not_deployed); this migration is what makes it real.
--
-- decision is always 'observe_only' (checked below) -- this table has no
-- reader on any paper, live, sizing, or order path. One row per
-- (symbol, market_session): the route's POST 23505-conflict handling assumes
-- exactly this uniqueness for its "already_recorded" idempotency response.

create table if not exists public.leveraged_etf_shadow_observations (
  id                  bigserial primary key,
  created_at          timestamptz not null default now(),
  market              text not null check (market = 'us'),
  market_session      text not null,
  observed_at         timestamptz not null,
  symbol              text not null check (symbol in ('TQQQ', 'SOXL')),
  underlying_symbol   text not null check (underlying_symbol in ('QQQ', 'SOXX')),
  policy_version      text not null,
  observation_window  text not null check (observation_window in ('inside_1100_et', 'outside_1100_et')),
  measurement_status  text not null check (measurement_status in ('complete', 'incomplete')),
  missing             jsonb not null default '[]'::jsonb check (jsonb_typeof(missing) = 'array'),
  features            jsonb not null check (jsonb_typeof(features) = 'object'),
  quote               jsonb not null check (jsonb_typeof(quote) = 'object'),
  decision            text not null default 'observe_only' check (decision = 'observe_only'),
  unique (symbol, market_session)
);

create index if not exists leveraged_etf_shadow_symbol_observed_idx
  on public.leveraged_etf_shadow_observations (symbol, observed_at desc);

create or replace function public.leveraged_etf_shadow_observations_immutable()
returns trigger language plpgsql set search_path = '' as $$
begin
  raise exception 'leveraged_etf_shadow_observations is append-only (evidence)';
end;
$$;

drop trigger if exists leveraged_etf_shadow_observations_no_mutation
  on public.leveraged_etf_shadow_observations;
create trigger leveraged_etf_shadow_observations_no_mutation
  before update or delete on public.leveraged_etf_shadow_observations
  for each row execute function public.leveraged_etf_shadow_observations_immutable();

drop trigger if exists leveraged_etf_shadow_observations_no_truncate
  on public.leveraged_etf_shadow_observations;
create trigger leveraged_etf_shadow_observations_no_truncate
  before truncate on public.leveraged_etf_shadow_observations
  for each statement execute function public.leveraged_etf_shadow_observations_immutable();

alter table public.leveraged_etf_shadow_observations enable row level security;

-- Both route handlers already require the owner session (requireOwner()) at
-- the app layer; RLS is the second barrier. No authenticated/anon policy is
-- created, matching user_broker_credentials' "nothing legitimate reads from
-- a browser" posture -- the route reads via the service-role client.
revoke insert, update, delete, truncate on public.leveraged_etf_shadow_observations
  from anon, authenticated;
revoke select on public.leveraged_etf_shadow_observations
  from anon, authenticated;

comment on table public.leveraged_etf_shadow_observations is
  'Append-only, measure-only L1 leveraged-ETF shadow evidence (TQQQ/SOXL vs QQQ/SOXX). No score, sizing, exit, paper, live, or order path reads this table. Written only via the owner-gated route using the service-role client.';
