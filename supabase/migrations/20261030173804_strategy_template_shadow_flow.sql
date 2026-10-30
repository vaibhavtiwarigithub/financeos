-- Strategy template shadow flow, deployed as a forward-only migration.
--
-- This migration intentionally leaves every older migration version untouched.
-- It installs the approved bounded, non-executing Strategy Portfolio Lab as a
-- new forward migration after the currently applied production version.

-- Two explicit price-only research patterns. These are separate from the
-- reference templates containing fundamental/volume clauses; no clause is
-- silently dropped to make a reference template appear runnable.
insert into public.strategy_templates(name,description,rules) values
  ('RSI Momentum · Price Only', 'Daily close momentum: Wilder RSI(14) at least 60 and close above SMA(50). Next-session-open replay.', '{"rsi_min":60,"above_ma50":true}'::jsonb),
  ('RSI Pullback · Price Only', 'Daily oversold pullback: Wilder RSI(14) at most 30 and close at least 15% below the trailing 252-session high. Next-session-open replay.', '{"rsi_max":30,"pct_below_52w_high_min":15}'::jsonb)
on conflict(name) do nothing;


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
  strategy_version_id bigint references public.strategy_versions(id),
  unique (market, config_fingerprint)
);
alter table public.strategy_template_shadow_configs
  add column if not exists strategy_version_id bigint references public.strategy_versions(id);
alter table public.strategy_template_shadow_configs enable row level security;
revoke all on public.strategy_template_shadow_configs from anon, authenticated;
revoke all on public.strategy_template_shadow_configs from service_role;
grant select on public.strategy_template_shadow_configs to authenticated;
grant select on public.strategy_template_shadow_configs to service_role;
drop policy if exists strategy_template_shadow_configs_owner_read on public.strategy_template_shadow_configs;
create policy strategy_template_shadow_configs_owner_read on public.strategy_template_shadow_configs for select to authenticated using ((select auth.jwt() ->> 'email') = 'vterminater@gmail.com');
drop policy if exists strategy_template_shadow_configs_service_all on public.strategy_template_shadow_configs;
create policy strategy_template_shadow_configs_service_all on public.strategy_template_shadow_configs for all to service_role using (true) with check (true);
drop function if exists public.create_strategy_template_shadow_config(text,uuid[],text,text,jsonb,text,text,jsonb,text);
create function public.create_strategy_template_shadow_config(
  p_market text, p_template_ids uuid[], p_kind text, p_operator text,
  p_weights jsonb, p_rule_version text, p_trial_family_id text,
  p_rule_spec jsonb, p_fingerprint text, p_historical_evidence jsonb default '{}'::jsonb
) returns public.strategy_template_shadow_configs language plpgsql security definer set search_path = pg_catalog, public as $$
declare
  v_row public.strategy_template_shadow_configs;
  v_strategy_id bigint;
  v_parent_id bigint;
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
  select * into v_row from public.strategy_template_shadow_configs
    where market = p_market and config_fingerprint = v_expected;
  if found then return v_row; end if;
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
  select id into v_parent_id from public.strategy_versions
    where market = p_market and is_champion = true order by promoted_at desc nulls last limit 1;
  insert into public.strategy_versions(
    version,name,description,universe,horizon_days_min,horizon_days_max,direction,
    entry_rules,exit_rules,weights_snapshot,state,parent_version_id,is_champion,
    market,genome,notes
  ) values (
    'template-' || left(v_expected,12),
    coalesce(p_rule_spec->>'label','Template shadow'),
    'Frozen, non-executing strategy-template measurement candidate.',
    case when p_market='india' then 'india_equity' else 'us_equity' end,
    nullif(p_rule_spec->>'horizonSessions','')::integer,
    nullif(p_rule_spec->>'horizonSessions','')::integer,'long',
    p_rule_spec->'entry',p_rule_spec->'exit',null,'measure_only',v_parent_id,false,
    p_market,p_rule_spec,
    'Template shadow only; cannot affect score, position, paper/live trade, or order.'
  ) returning id into v_strategy_id;
  insert into public.strategy_template_shadow_configs(market,template_ids,kind,operator,weights,rule_version,trial_family_id,rule_spec,config_fingerprint,strategy_version_id)
  values(p_market,v_ids,p_kind,p_operator,coalesce(p_weights,'{}'::jsonb),p_rule_version,p_trial_family_id,p_rule_spec,v_expected,v_strategy_id)
  returning * into v_row;
  insert into public.strategy_template_shadow_events(config_id,event,reason,evidence_snapshot,actor)
  values(v_row.id,'created','owner_created',jsonb_build_object('config_fingerprint',v_expected,'client_fingerprint',p_fingerprint,'historical_evidence',coalesce(p_historical_evidence,'{}'::jsonb),'strategy_version_id',v_strategy_id),'owner');
  return v_row;
end $$;
revoke all on function public.create_strategy_template_shadow_config(text,uuid[],text,text,jsonb,text,text,jsonb,text,jsonb) from public, anon, authenticated;
grant execute on function public.create_strategy_template_shadow_config(text,uuid[],text,text,jsonb,text,text,jsonb,text,jsonb) to service_role;

-- ---------------------------------------------------------------------------
-- 2. Defining fields are IMMUTABLE once written.
-- ---------------------------------------------------------------------------
create or replace function public.strategy_template_shadow_configs_immutable()
returns trigger language plpgsql as $$
begin
  if new.market is distinct from old.market
     or new.id is distinct from old.id
     or new.template_ids is distinct from old.template_ids
     or new.kind is distinct from old.kind
     or new.operator is distinct from old.operator
     or new.weights is distinct from old.weights
     or new.rule_version is distinct from old.rule_version
     or new.trial_family_id is distinct from old.trial_family_id
     or new.rule_spec is distinct from old.rule_spec
     or new.strategy_version_id is distinct from old.strategy_version_id
     or new.config_fingerprint is distinct from old.config_fingerprint
     or new.created_by is distinct from old.created_by
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

create or replace function public.strategy_template_shadow_configs_no_delete()
returns trigger language plpgsql set search_path = pg_catalog, public as $$
begin
  raise exception 'strategy_template_shadow_configs are retained; retire via lifecycle RPC';
end $$;
drop trigger if exists strategy_template_shadow_configs_no_delete_trg on public.strategy_template_shadow_configs;
create trigger strategy_template_shadow_configs_no_delete_trg
  before delete on public.strategy_template_shadow_configs
  for each row execute function public.strategy_template_shadow_configs_no_delete();

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
  event text not null check (event in ('created','backtest_completed','validating','shadow','paused','resumed','retired')),
  reason text not null,
  -- Snapshot of the evidence the decision was made on. Never a pointer that can
  -- later change underneath the decision.
  evidence_snapshot jsonb,
  actor text not null,
  created_at timestamptz not null default now()
);
alter table public.strategy_template_shadow_events
  drop constraint if exists strategy_template_shadow_events_event_check;
alter table public.strategy_template_shadow_events
  add constraint strategy_template_shadow_events_event_check
  check (event in ('created','backtest_completed','validating','shadow','paused','resumed','retired'));
create index if not exists strategy_template_shadow_events_config_idx
  on public.strategy_template_shadow_events (config_id, created_at desc);

alter table public.strategy_template_shadow_events enable row level security;
revoke all on public.strategy_template_shadow_events from anon, authenticated;
revoke truncate on public.strategy_template_shadow_events from public, anon, authenticated, service_role;
revoke all on public.strategy_template_shadow_events from service_role;
grant select on public.strategy_template_shadow_events to service_role;
grant select on public.strategy_template_shadow_events to authenticated;
grant select on public.strategy_template_shadow_events to service_role;
drop policy if exists strategy_template_shadow_events_owner_read on public.strategy_template_shadow_events;
create policy strategy_template_shadow_events_owner_read
  on public.strategy_template_shadow_events for select to authenticated
  using ((select auth.jwt() ->> 'email') = 'vterminater@gmail.com');
drop policy if exists strategy_template_shadow_events_service_all on public.strategy_template_shadow_events;
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

-- Append-only forward decisions and matured labels use a separate ledger so a
-- template rule's boolean decision cannot be confused with a dimension score.
create table if not exists public.strategy_template_shadow_decisions (
  id bigserial primary key,
  config_id uuid not null references public.strategy_template_shadow_configs(id),
  strategy_version_id bigint not null references public.strategy_versions(id),
  market text not null check (market in ('us','india')),
  symbol text not null,
  signal_session date not null,
  observation_id bigint references public.decision_observations(id),
  would_enter boolean not null,
  baseline_entry_eligible boolean not null,
  decision_close numeric not null check (decision_close > 0),
  decision_price_basis text not null,
  decision_provenance text not null,
  compiler_version text not null,
  data_source text not null,
  created_at timestamptz not null default now(),
  unique (config_id,symbol,signal_session)
);
create index if not exists template_shadow_decisions_config_session_idx
  on public.strategy_template_shadow_decisions(config_id,signal_session desc);
create index if not exists template_shadow_decisions_symbol_session_idx
  on public.strategy_template_shadow_decisions(market,symbol,signal_session desc);
alter table public.strategy_template_shadow_decisions add column if not exists decision_price_basis text not null default 'unknown';
alter table public.strategy_template_shadow_decisions add column if not exists decision_provenance text not null default 'legacy_unknown';
alter table public.strategy_template_shadow_decisions enable row level security;
revoke all on public.strategy_template_shadow_decisions from public, anon, authenticated;
grant select on public.strategy_template_shadow_decisions to authenticated;
revoke all on public.strategy_template_shadow_decisions from service_role;
grant select, insert on public.strategy_template_shadow_decisions to service_role;
drop policy if exists strategy_template_shadow_decisions_owner_read on public.strategy_template_shadow_decisions;
create policy strategy_template_shadow_decisions_owner_read on public.strategy_template_shadow_decisions
  for select to authenticated using ((select auth.jwt() ->> 'email') = 'vterminater@gmail.com');
drop policy if exists strategy_template_shadow_decisions_service_all on public.strategy_template_shadow_decisions;
create policy strategy_template_shadow_decisions_service_all on public.strategy_template_shadow_decisions
  for all to service_role using (true) with check (true);

create table if not exists public.strategy_template_shadow_outcomes (
  id bigserial primary key,
  decision_id bigint not null unique references public.strategy_template_shadow_decisions(id),
  entry_session date not null,
  exit_session date not null,
  entry_open numeric not null check (entry_open > 0),
  exit_open numeric not null check (exit_open > 0),
  gross_return_pct numeric not null,
  net_return_pct numeric not null,
  modeled_cost_pct numeric not null,
  price_source text not null,
  price_basis text not null,
  provenance_version text not null,
  matured_at timestamptz not null default now()
);
create index if not exists template_shadow_outcomes_exit_session_idx
  on public.strategy_template_shadow_outcomes(exit_session desc);
alter table public.strategy_template_shadow_outcomes enable row level security;
revoke all on public.strategy_template_shadow_outcomes from public, anon, authenticated;
grant select on public.strategy_template_shadow_outcomes to authenticated;
revoke all on public.strategy_template_shadow_outcomes from service_role;
grant select, insert on public.strategy_template_shadow_outcomes to service_role;
drop policy if exists strategy_template_shadow_outcomes_owner_read on public.strategy_template_shadow_outcomes;
create policy strategy_template_shadow_outcomes_owner_read on public.strategy_template_shadow_outcomes
  for select to authenticated using ((select auth.jwt() ->> 'email') = 'vterminater@gmail.com');
drop policy if exists strategy_template_shadow_outcomes_service_all on public.strategy_template_shadow_outcomes;
create policy strategy_template_shadow_outcomes_service_all on public.strategy_template_shadow_outcomes
  for all to service_role using (true) with check (true);

create or replace function public.strategy_template_shadow_append_only()
returns trigger language plpgsql set search_path = pg_catalog, public as $$
begin
  raise exception '% is append-only', tg_table_name;
end $$;
drop trigger if exists strategy_template_shadow_decisions_no_mutation on public.strategy_template_shadow_decisions;
create trigger strategy_template_shadow_decisions_no_mutation before update or delete on public.strategy_template_shadow_decisions
  for each row execute function public.strategy_template_shadow_append_only();
drop trigger if exists strategy_template_shadow_outcomes_no_mutation on public.strategy_template_shadow_outcomes;
create trigger strategy_template_shadow_outcomes_no_mutation before update or delete on public.strategy_template_shadow_outcomes
  for each row execute function public.strategy_template_shadow_append_only();
revoke truncate on public.strategy_template_shadow_decisions, public.strategy_template_shadow_outcomes from public, anon, authenticated, service_role;

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

drop function if exists public.transition_strategy_template_shadow_config(uuid,text,text,jsonb);
create function public.transition_strategy_template_shadow_config(
  p_config_id uuid, p_event text, p_reason text, p_evidence_snapshot jsonb default '{}'::jsonb
) returns public.strategy_template_shadow_configs language plpgsql security definer set search_path = pg_catalog, public as $$
declare
  v_row public.strategy_template_shadow_configs;
  v_backtest jsonb;
begin
  if p_event not in ('validating','shadow','paused','resumed','retired') or nullif(trim(p_reason),'') is null then
    raise exception 'invalid lifecycle transition';
  end if;
  select * into v_row from public.strategy_template_shadow_configs where id = p_config_id for update;
  if not found then raise exception 'template shadow config not found'; end if;
  if v_row.state = 'retired' then raise exception 'retired config cannot transition'; end if;
  if p_event = 'shadow' or p_event = 'resumed' then
    select evidence_snapshot->'historical_evidence' into v_backtest
      from public.strategy_template_shadow_events
      where config_id = p_config_id and event = 'created'
      order by created_at asc, id asc limit 1;
    if coalesce(v_backtest->>'status','') <> 'diagnostic_only'
       or coalesce((v_backtest->'holdout'->>'sessions')::integer,0) < 30
       or coalesce((v_backtest->'holdout'->>'trades')::integer,0) < 1
       or coalesce((v_backtest->'holdout'->>'unpricedSessions')::integer,1) <> 0
       or coalesce((v_backtest->'holdout'->>'benchmarkMissingSessions')::integer,1) <> 0
       or v_backtest->'holdout'->>'excessReturnPp' is null then
      raise exception 'historical evidence gate not met: require a 30-session priced benchmark holdout with at least one completed entry';
    end if;
  end if;
  if (p_event = 'validating' and v_row.state <> 'draft')
     or (p_event = 'shadow' and v_row.state not in ('draft','validating','paused'))
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

-- Service-only evidence insertion; table policies still give the owner read-only access.
revoke insert, update, delete, truncate on public.strategy_template_shadow_events,
  public.strategy_template_shadow_decisions, public.strategy_template_shadow_outcomes
  from public, anon, authenticated;
grant insert on public.strategy_template_shadow_decisions, public.strategy_template_shadow_outcomes to service_role;
revoke all on sequence public.strategy_template_shadow_events_id_seq from service_role;
grant usage, select on sequence public.strategy_template_shadow_events_id_seq,
  public.strategy_template_shadow_decisions_id_seq, public.strategy_template_shadow_outcomes_id_seq to service_role;
