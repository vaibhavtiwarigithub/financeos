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
-- returns NULL in production. Revised for owner approval 2026-09-13; because
-- this migration has never been applied, it is replaced in-place rather than
-- deployed as an unsafe predecessor followed by a repair.

create extension if not exists pgcrypto;

create table if not exists public.strategy_template_shadow_configs (
  id uuid primary key default gen_random_uuid(),
  market text not null check (market in ('us','india')),
  template_ids uuid[] not null check (cardinality(template_ids) between 1 and 3),
  kind text not null check (kind in ('template','combination')),
  -- FULL identity, not just the constituents. Two combinations differing only in
  -- operator or weights are DIFFERENT experiments and must not collide.
  operator text not null default 'single'
    check (operator in ('single','parallel_sleeves','confirmation','regime_routing')),
  weights jsonb not null default '{}'::jsonb,
  rule_version text not null,
  trial_family_id text not null,
  rule_spec jsonb not null,
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
create or replace function public.create_strategy_template_shadow_config(
  p_market text, p_template_ids uuid[], p_kind text, p_operator text,
  p_weights jsonb, p_rule_version text, p_trial_family_id text,
  p_rule_spec jsonb, p_fingerprint text
) returns public.strategy_template_shadow_configs language plpgsql security definer set search_path = public as $$
declare
  v_row public.strategy_template_shadow_configs;
  v_ids uuid[];
  v_expected text;
  v_count integer;
  v_weight_sum numeric;
begin
  if p_market not in ('us','india') or p_kind not in ('template','combination')
     or cardinality(p_template_ids) not between 1 and 3 or p_rule_spec is null
     or nullif(trim(p_rule_version), '') is null or nullif(trim(p_trial_family_id), '') is null then
    raise exception 'invalid template shadow configuration';
  end if;
  select array_agg(id order by id) into v_ids from unnest(p_template_ids) as id;
  if cardinality(v_ids) <> cardinality(p_template_ids)
     or cardinality(array(select distinct id from unnest(p_template_ids) as id)) <> cardinality(p_template_ids) then
    raise exception 'template ids must be unique';
  end if;
  if (p_kind = 'template' and (cardinality(v_ids) <> 1 or p_operator <> 'single'))
     or (p_kind = 'combination' and (cardinality(v_ids) < 2 or p_operator not in ('parallel_sleeves','confirmation','regime_routing'))) then
    raise exception 'invalid kind/operator/template count';
  end if;
  if p_rule_spec->>'market' is distinct from p_market or p_rule_spec->>'ruleVersion' is distinct from p_rule_version then
    raise exception 'rule spec market/version mismatch';
  end if;
  select count(*) into v_count from public.strategy_templates where id = any(v_ids);
  if v_count <> cardinality(v_ids) then raise exception 'unknown template id'; end if;
  select coalesce(sum(value::numeric), 0) into v_weight_sum from jsonb_each_text(coalesce(p_weights, '{}'::jsonb));
  if p_operator in ('parallel_sleeves','regime_routing') and abs(v_weight_sum - 1) > 0.000000001 then
    raise exception 'weights must sum to one';
  end if;
  if exists (select 1 from jsonb_object_keys(coalesce(p_weights, '{}'::jsonb)) k where not (k::uuid = any(v_ids))) then
    raise exception 'weights include an unselected template';
  end if;
  v_expected := encode(digest(jsonb_build_object(
    'market',p_market,'template_ids',to_jsonb(v_ids),'kind',p_kind,'operator',p_operator,
    'weights',coalesce(p_weights,'{}'::jsonb),'rule_version',p_rule_version,
    'trial_family_id',p_trial_family_id,'rule_spec',p_rule_spec
  )::text, 'sha256'), 'hex');
  -- The server-derived fingerprint is authoritative. The caller's fingerprint
  -- is accepted only as diagnostic context because JSON serialization differs
  -- across clients; trusting it would reintroduce the collision boundary this
  -- RPC exists to close.
  perform pg_advisory_xact_lock(hashtext('strategy-template-shadow:' || p_market));
  if (select count(*) from public.strategy_template_shadow_configs where market=p_market and state in ('draft','validating','shadow','paused')) >= 3 then
    raise exception 'market template-shadow capacity reached';
  end if;
  perform public.register_trial(p_trial_family_id, v_expected,
    case when p_kind = 'combination' then 'combination' else 'rule' end,
    coalesce(p_rule_spec->>'label',p_rule_spec->>'id','template shadow'),
    jsonb_build_object('market',p_market,'template_ids',to_jsonb(v_ids),'kind',p_kind,'operator',p_operator,'weights',coalesce(p_weights,'{}'::jsonb),'rule_spec',p_rule_spec),
    'strategy_template_shadow', null, null);
  insert into public.strategy_template_shadow_configs(market,template_ids,kind,operator,weights,rule_version,trial_family_id,rule_spec,config_fingerprint)
  values(p_market,v_ids,p_kind,p_operator,coalesce(p_weights,'{}'::jsonb),p_rule_version,p_trial_family_id,p_rule_spec,v_expected)
  returning * into v_row;
  insert into public.strategy_template_shadow_events(config_id,event,reason,evidence_snapshot,actor)
  values(v_row.id,'created','owner_created',jsonb_build_object('config_fingerprint',v_expected,'client_fingerprint',p_fingerprint),'owner');
  return v_row;
end $$;
revoke all on function public.create_strategy_template_shadow_config(text,uuid[],text,text,jsonb,text,text,jsonb,text) from public, anon, authenticated;
grant execute on function public.create_strategy_template_shadow_config(text,uuid[],text,text,jsonb,text,text,jsonb,text) to service_role;

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
     or new.rule_spec is distinct from old.rule_spec
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

-- State is a cached projection. Only this RPC may advance it, and every
-- advance appends an event first. A direct service-role update is rejected too.
create or replace function public.strategy_template_shadow_state_guard()
returns trigger language plpgsql as $$
begin
  if (new.state is distinct from old.state or new.retired_at is distinct from old.retired_at)
     and current_setting('app.template_shadow_lifecycle', true) is distinct from '1' then
    raise exception 'strategy template shadow state must be changed through lifecycle RPC';
  end if;
  return new;
end $$;

drop trigger if exists strategy_template_shadow_state_guard_trg on public.strategy_template_shadow_configs;
create trigger strategy_template_shadow_state_guard_trg
  before update on public.strategy_template_shadow_configs
  for each row execute function public.strategy_template_shadow_state_guard();

create or replace function public.transition_strategy_template_shadow_config(
  p_config_id uuid, p_event text, p_reason text, p_evidence_snapshot jsonb default '{}'::jsonb
) returns public.strategy_template_shadow_configs language plpgsql security definer set search_path = public as $$
declare v_row public.strategy_template_shadow_configs;
begin
  if p_event not in ('validating','shadow','paused','resumed','retired') or nullif(trim(p_reason),'') is null then
    raise exception 'invalid lifecycle transition';
  end if;
  select * into v_row from public.strategy_template_shadow_configs where id = p_config_id for update;
  if not found then raise exception 'template shadow config not found'; end if;
  if v_row.state = 'retired' then raise exception 'retired config cannot transition'; end if;
  if (p_event = 'validating' and v_row.state <> 'draft')
     or (p_event = 'shadow' and v_row.state not in ('validating','paused'))
     or (p_event = 'paused' and v_row.state not in ('draft','validating','shadow'))
     or (p_event = 'resumed' and v_row.state <> 'paused') then
    raise exception 'invalid lifecycle transition from % via %', v_row.state, p_event;
  end if;
  insert into public.strategy_template_shadow_events(config_id,event,reason,evidence_snapshot,actor)
  values(p_config_id,p_event,p_reason,coalesce(p_evidence_snapshot,'{}'::jsonb),'owner');
  perform set_config('app.template_shadow_lifecycle','1',true);
  update public.strategy_template_shadow_configs
    set state = case when p_event = 'resumed' then 'shadow' else p_event end,
        retired_at = case when p_event = 'retired' then now() else retired_at end
    where id = p_config_id
    returning * into v_row;
  return v_row;
end $$;
revoke all on function public.transition_strategy_template_shadow_config(uuid,text,text,jsonb) from public, anon, authenticated;
grant execute on function public.transition_strategy_template_shadow_config(uuid,text,text,jsonb) to service_role;
