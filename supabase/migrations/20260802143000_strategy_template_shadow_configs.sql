-- Strategy template shadow configs.
--
-- ***** NOT APPLIED TO PRODUCTION. DO NOT APPLY UNCHANGED. *****
--
-- Independent review 2026-09-01 found this migration unsafe as written:
--
--   1. `config_fingerprint` covered only (market, kind, template_ids). It omitted
--      OPERATOR, WEIGHTS, RULE VERSION and TRIAL FAMILY, so two materially
--      different combinations -- say A+B under `confirmation` at equal weight and
--      A+B under `regime_routing` at 70/30 -- collide on one row. One silently
--      overwrites the other, or the second is rejected as a duplicate.
--   2. No immutable-config trigger: a row's defining fields could be edited after
--      evidence had been collected against them, which breaks the frozen-history
--      rule (annotate, never re-decide).
--   3. `state` and `retired_at` are MUTABLE state with no history. There is no
--      record of who retired a config, when, why, or on what evidence.
--
-- The corrected shape is below. It is committed so the design is reviewable and
-- version-controlled, and deliberately left UNAPPLIED until the feature that
-- needs it is approved -- see features/external-strategy-discovery
-- (Stage 0R, step 1).
--
-- Verified 2026-09-01: `to_regclass('public.strategy_template_shadow_configs')`
-- returns NULL in production.

create table if not exists public.strategy_template_shadow_configs (
  id uuid primary key default gen_random_uuid(),
  market text not null check (market in ('us','india')),
  template_ids text[] not null check (cardinality(template_ids) between 1 and 3),
  kind text not null check (kind in ('template','combination')),
  -- FULL identity, not just the constituents. Two combinations differing only in
  -- operator or weights are DIFFERENT experiments and must not collide.
  operator text not null default 'single'
    check (operator in ('single','parallel_sleeves','confirmation','regime_routing')),
  weights jsonb not null default '{}'::jsonb,
  rule_version text not null,
  trial_family_id text not null,
  -- Must be computed over (market, kind, template_ids, operator, weights,
  -- rule_version, trial_family_id) -- never over the constituents alone.
  config_fingerprint text not null check (config_fingerprint ~ '^[a-f0-9]{64}$'),
  state text not null default 'draft' check (state in ('draft','validating','shadow','paused','retired')),
  created_at timestamptz not null default now(),
  created_by text not null default 'owner',
  retired_at timestamptz,
  unique (market, config_fingerprint)
);
alter table public.strategy_template_shadow_configs enable row level security;
revoke all on public.strategy_template_shadow_configs from anon, authenticated;
grant select on public.strategy_template_shadow_configs to authenticated;
create policy strategy_template_shadow_configs_owner_read on public.strategy_template_shadow_configs for select to authenticated using ((select auth.jwt() ->> 'email') = 'vterminater@gmail.com');
create policy strategy_template_shadow_configs_service_all on public.strategy_template_shadow_configs for all to service_role using (true) with check (true);
create or replace function public.create_strategy_template_shadow_config(p_market text, p_template_ids text[], p_kind text, p_fingerprint text)
returns public.strategy_template_shadow_configs language plpgsql security definer set search_path = public as $$
declare v_row public.strategy_template_shadow_configs; v_limit int;
begin
  if p_market not in ('us','india') or p_kind not in ('template','combination') or cardinality(p_template_ids) not between 1 and 3 then raise exception 'invalid template shadow configuration'; end if;
  perform pg_advisory_xact_lock(hashtext('strategy-template-shadow:' || p_market));
  select case when p_kind='template' then 3 else 1 end into v_limit;
  if (select count(*) from public.strategy_template_shadow_configs where market=p_market and kind=p_kind and state in ('draft','validating','shadow','paused')) >= v_limit then raise exception 'market template-shadow capacity reached'; end if;
  insert into public.strategy_template_shadow_configs(market,template_ids,kind,config_fingerprint) values(p_market,p_template_ids,p_kind,p_fingerprint) returning * into v_row;
  return v_row;
end $$;
revoke all on function public.create_strategy_template_shadow_config(text,text[],text,text) from public, anon, authenticated;
grant execute on function public.create_strategy_template_shadow_config(text,text[],text,text) to service_role;

-- ---------------------------------------------------------------------------
-- 2. Defining fields are IMMUTABLE once written.
-- ---------------------------------------------------------------------------
create or replace function public.strategy_template_shadow_configs_immutable()
returns trigger language plpgsql as $$
begin
  if new.market is distinct from old.market
     or new.template_ids is distinct from old.template_ids
     or new.kind is distinct from old.kind
     or new.operator is distinct from old.operator
     or new.weights is distinct from old.weights
     or new.rule_version is distinct from old.rule_version
     or new.trial_family_id is distinct from old.trial_family_id
     or new.config_fingerprint is distinct from old.config_fingerprint
     or new.created_at is distinct from old.created_at then
    raise exception 'strategy_template_shadow_configs: defining fields are immutable (id %)', old.id;
  end if;
  return new;
end $$;

drop trigger if exists strategy_template_shadow_configs_immutable_trg
  on public.strategy_template_shadow_configs;
create trigger strategy_template_shadow_configs_immutable_trg
  before update on public.strategy_template_shadow_configs
  for each row execute function public.strategy_template_shadow_configs_immutable();

-- ---------------------------------------------------------------------------
-- 3. Lifecycle is an APPEND-ONLY ledger, not a mutable column.
--
-- Retirement without a recorded reason, evidence and actor is a decision nobody
-- can audit later. `state` on the config row remains a cached projection of the
-- newest event; this table is the record.
-- ---------------------------------------------------------------------------
create table if not exists public.strategy_template_shadow_events (
  id bigserial primary key,
  config_id uuid not null references public.strategy_template_shadow_configs(id),
  event text not null check (event in ('created','validating','shadow','paused','resumed','retired')),
  reason text not null,
  -- Snapshot of the evidence the decision was made on. Never a pointer that can
  -- later change underneath the decision.
  evidence_snapshot jsonb,
  actor text not null,
  created_at timestamptz not null default now()
);
create index if not exists strategy_template_shadow_events_config_idx
  on public.strategy_template_shadow_events (config_id, created_at desc);

alter table public.strategy_template_shadow_events enable row level security;
revoke all on public.strategy_template_shadow_events from anon, authenticated;
grant select on public.strategy_template_shadow_events to authenticated;
create policy strategy_template_shadow_events_owner_read
  on public.strategy_template_shadow_events for select to authenticated
  using ((select auth.jwt() ->> 'email') = 'vterminater@gmail.com');
create policy strategy_template_shadow_events_service_all
  on public.strategy_template_shadow_events for all to service_role
  using (true) with check (true);

-- Append-only: no update, no delete.
create or replace function public.strategy_template_shadow_events_append_only()
returns trigger language plpgsql as $$
begin
  raise exception 'strategy_template_shadow_events is append-only';
end $$;

drop trigger if exists strategy_template_shadow_events_no_update_trg
  on public.strategy_template_shadow_events;
create trigger strategy_template_shadow_events_no_update_trg
  before update or delete on public.strategy_template_shadow_events
  for each row execute function public.strategy_template_shadow_events_append_only();
