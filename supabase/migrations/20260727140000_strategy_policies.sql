-- Strategy promotion destination.
-- Deterministic gate writes here; LLM never writes here.
-- promoted_by is constrained to 'deterministic_gate' — enforced at DB level.
-- Append-only for the core fields; superseded_at is the only mutable column (trigger below).
-- One active policy per (market, sector, regime, horizon_days_min, horizon_days_max) at a time.

create table if not exists public.strategy_policies (
  id                    uuid primary key default gen_random_uuid(),
  market                text not null check (market in ('us', 'india')),
  sector                text,                        -- null = all sectors
  regime                text check (regime in ('trend', 'mean_revert', 'high_vol', 'low_vol')),
  horizon_days_min      int not null check (horizon_days_min > 0),
  horizon_days_max      int not null check (horizon_days_max >= horizon_days_min),
  model_id              text not null,               -- edge formula_version or run_fingerprint
  verdict               text not null check (verdict in ('baseline', 'variant', 'abstain')),
  sample_n              int not null check (sample_n >= 0),
  dsr                   float,                       -- Deflated Sharpe Ratio (Bailey 2014)
  pbo                   float check (pbo is null or (pbo >= 0 and pbo <= 1)),
  walk_forward_pass     bool,
  cost_adjusted_return  float,
  max_drawdown_pct      float,
  stability_score       float,
  promoted_at           timestamptz not null default now(),
  promoted_by           text not null default 'deterministic_gate'
                          check (promoted_by = 'deterministic_gate'),
  superseded_at         timestamptz,                 -- set when a newer policy wins this segment
  notes                 text,
  created_at            timestamptz not null default now()
);

-- Only one active (non-superseded) policy per segment at a time.
create unique index if not exists strategy_policies_active_segment_uidx
  on public.strategy_policies (market, coalesce(sector,'__all__'), coalesce(regime,'__all__'), horizon_days_min, horizon_days_max)
  where superseded_at is null;

-- Fast lookup: ResearchAgent reads by market + optional sector/regime + horizon.
create index if not exists strategy_policies_lookup_idx
  on public.strategy_policies (market, sector, regime, horizon_days_min, horizon_days_max)
  where superseded_at is null;

-- Core fields are immutable after insert; only superseded_at may be updated.
create or replace function public.strategy_policies_guard_mutation()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if (old.market              is distinct from new.market or
      old.sector              is distinct from new.sector or
      old.regime              is distinct from new.regime or
      old.horizon_days_min    is distinct from new.horizon_days_min or
      old.horizon_days_max    is distinct from new.horizon_days_max or
      old.model_id            is distinct from new.model_id or
      old.verdict             is distinct from new.verdict or
      old.sample_n            is distinct from new.sample_n or
      old.promoted_by         is distinct from new.promoted_by or
      old.promoted_at         is distinct from new.promoted_at) then
    raise exception 'strategy_policies: only superseded_at may be updated after insert';
  end if;
  return new;
end;
$$;

drop trigger if exists strategy_policies_no_core_mutation on public.strategy_policies;
create trigger strategy_policies_no_core_mutation
  before update on public.strategy_policies
  for each row execute function public.strategy_policies_guard_mutation();

-- Deletes are never allowed.
create or replace function public.strategy_policies_block_delete()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception 'strategy_policies is append-only; set superseded_at instead of deleting';
end;
$$;

drop trigger if exists strategy_policies_no_delete on public.strategy_policies;
create trigger strategy_policies_no_delete
  before delete on public.strategy_policies
  for each row execute function public.strategy_policies_block_delete();

-- RLS: service role only (cron/agent); no user-facing writes.
alter table public.strategy_policies enable row level security;

create policy "service role full access"
  on public.strategy_policies
  using (auth.role() = 'service_role');
