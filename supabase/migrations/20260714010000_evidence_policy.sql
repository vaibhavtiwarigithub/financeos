-- Canonical Evidence Router — Phase 2 foundation (1/3): policy & version tables.
--
-- Immutable per-market policy VERSIONS + a mutable ACTIVE pointer, so a research
-- run freezes exactly one policy version and a routing change never mutates
-- history. router_enabled defaults FALSE everywhere — this migration ships the
-- schema + a seeded all-Auto version but changes NO routing behavior. No table
-- here touches scoring, orders, cash, or the money path.
--
-- Owner-read RLS (vterminater@gmail.com), service-role writes only. Policy
-- versions / rules / evaluations are append-only (UPDATE/DELETE trigger-blocked);
-- only the active pointer is mutable, and only through the activation RPC.

-- ── immutable policy versions ────────────────────────────────────────────────
create table if not exists public.evidence_policy_versions (
  id            uuid primary key default gen_random_uuid(),
  market        text not null check (market in ('us','india')),
  version       int  not null,
  router_enabled boolean not null default false,
  created_by    uuid,
  created_at    timestamptz not null default now(),
  change_note   text,
  unique (market, version)
);

-- ── mutable active pointer (one row per market) ──────────────────────────────
create table if not exists public.active_evidence_policy (
  market            text primary key check (market in ('us','india')),
  policy_version_id uuid not null references public.evidence_policy_versions(id),
  activated_by      uuid,
  activated_at      timestamptz not null default now()
);

-- ── immutable per-version rules (one per intent) ─────────────────────────────
create table if not exists public.evidence_policy_rules (
  policy_version_id  uuid not null references public.evidence_policy_versions(id),
  intent             text not null,
  mode               text not null default 'auto' check (mode in ('auto','prefer','only','off')),
  preferred_provider text,
  max_age_seconds    int  not null default 86400 check (max_age_seconds >= 0),
  stale_max_seconds  int  not null default 259200 check (stale_max_seconds >= 0),
  max_sync_attempts  int  not null default 2 check (max_sync_attempts between 0 and 2),
  advanced_config    jsonb,
  primary key (policy_version_id, intent),
  -- prefer/only require a named provider; auto/off must not name one.
  constraint policy_rule_provider_shape check (
    (mode in ('prefer','only') and preferred_provider is not null) or
    (mode in ('auto','off')    and preferred_provider is null)
  ),
  -- stale ceiling can never be tighter than the fresh window.
  constraint policy_rule_stale_ge_fresh check (stale_max_seconds >= max_age_seconds)
);

-- ── current operational per-provider overrides (conservative only) ───────────
create table if not exists public.provider_runtime_config (
  provider_id                text primary key,
  enabled                    boolean not null default true,
  daily_limit_state          text not null default 'unknown' check (daily_limit_state in ('known','none','unknown')),
  daily_limit_override       int,
  rate_limit_state           text not null default 'unknown' check (rate_limit_state in ('known','none','unknown')),
  rate_limit_calls_override  int,
  rate_window_seconds_override int,
  min_interval_ms_override   int,
  reserve_calls_override     int,
  updated_at                 timestamptz not null default now()
);

-- ── per provider/market/intent capability maturity ───────────────────────────
create table if not exists public.provider_capability_status (
  provider_id               text not null,
  market                    text not null check (market in ('us','india')),
  intent                    text not null,
  contract_state            text not null default 'unverified' check (contract_state in ('unverified','valid','invalid')),
  maturity_state            text not null default 'discovered'  check (maturity_state in ('discovered','contract_valid','shadow_validated','production_eligible')),
  entitlement_state         text not null default 'unknown'     check (entitlement_state in ('unknown','active','inactive')),
  contract_version          text,
  last_probe_at             timestamptz,
  last_shadow_evaluation_id uuid,
  updated_at                timestamptz not null default now(),
  primary key (provider_id, market, intent)
);

-- ── append-only shadow-evaluation proof ──────────────────────────────────────
create table if not exists public.evidence_policy_evaluations (
  id                    uuid primary key default gen_random_uuid(),
  candidate_version_id  uuid not null references public.evidence_policy_versions(id),
  baseline_version_id   uuid references public.evidence_policy_versions(id),
  market                text not null check (market in ('us','india')),
  sample                jsonb,
  coverage_delta        jsonb,
  schema_failures       int not null default 0,
  provider_disagreement jsonb,
  score_delta           jsonb,
  eligibility_flips     int not null default 0,
  call_usage            jsonb,
  passed                boolean not null default false,
  reason                text,
  created_at            timestamptz not null default now()
);

create index if not exists evidence_policy_eval_candidate_idx
  on public.evidence_policy_evaluations (candidate_version_id, created_at desc);

-- ── append-only enforcement ──────────────────────────────────────────────────
create or replace function public.evidence_block_mutation()
returns trigger language plpgsql as $$
begin
  raise exception 'append-only table %: UPDATE/DELETE not permitted', tg_table_name;
end $$;

drop trigger if exists no_mutate on public.evidence_policy_versions;
create trigger no_mutate before update or delete on public.evidence_policy_versions
  for each row execute function public.evidence_block_mutation();

drop trigger if exists no_mutate on public.evidence_policy_rules;
create trigger no_mutate before update or delete on public.evidence_policy_rules
  for each row execute function public.evidence_block_mutation();

drop trigger if exists no_mutate on public.evidence_policy_evaluations;
create trigger no_mutate before update or delete on public.evidence_policy_evaluations
  for each row execute function public.evidence_block_mutation();

-- ── atomic activation RPC ────────────────────────────────────────────────────
-- Points active_evidence_policy at a target version under a per-market advisory
-- lock. Validates the target version belongs to the same market and has exactly
-- one rule for every intent in the given required set. NEVER runs a research run
-- or calls a provider. Score-affecting-change gating (requiring a passing
-- evaluation) is enforced at the API layer; this RPC is the atomic pointer swap.
create or replace function public.activate_evidence_policy(
  p_market text,
  p_version_id uuid,
  p_required_intents text[],
  p_actor uuid default null
) returns void
language plpgsql
security definer
set search_path = public
as $$
declare v_market text; missing text;
begin
  if p_market not in ('us','india') then
    raise exception 'invalid market %', p_market;
  end if;
  perform pg_advisory_xact_lock(hashtext('evidence_policy_activate:' || p_market));

  select market into v_market from public.evidence_policy_versions where id = p_version_id;
  if v_market is null then raise exception 'unknown policy version %', p_version_id; end if;
  if v_market <> p_market then
    raise exception 'version % is market % not %', p_version_id, v_market, p_market;
  end if;

  -- every required intent must have exactly one rule in this version
  select string_agg(ri, ',') into missing
  from unnest(p_required_intents) ri
  where not exists (
    select 1 from public.evidence_policy_rules r
    where r.policy_version_id = p_version_id and r.intent = ri
  );
  if missing is not null then
    raise exception 'version % missing rules for intent(s): %', p_version_id, missing;
  end if;

  insert into public.active_evidence_policy (market, policy_version_id, activated_by, activated_at)
  values (p_market, p_version_id, p_actor, now())
  on conflict (market) do update
    set policy_version_id = excluded.policy_version_id,
        activated_by = excluded.activated_by,
        activated_at = now();
end $$;

revoke all on function public.activate_evidence_policy(text, uuid, text[], uuid) from public;
grant execute on function public.activate_evidence_policy(text, uuid, text[], uuid) to service_role;

-- ── seed one all-Auto version per market (router_enabled = false) ─────────────
do $$
declare m text; vid uuid; ints text[] := array[
  'price.quote','price.daily_bars','fundamentals.reported','fundamentals.valuation',
  'analyst.consensus','sentiment.news','insider.transactions','events.earnings',
  'events.corporate_actions','macro.regime_inputs'];
  i text;
begin
  foreach m in array array['us','india'] loop
    if not exists (select 1 from public.evidence_policy_versions where market = m and version = 1) then
      insert into public.evidence_policy_versions (market, version, router_enabled, change_note)
      values (m, 1, false, 'seed: all-Auto, router disabled')
      returning id into vid;
      foreach i in array ints loop
        -- analyst.consensus is US-only per the intent catalog; still seed a rule
        -- row for India so activation's required-intent check is satisfiable, but
        -- it will resolve unavailable there (no India analyst provider).
        insert into public.evidence_policy_rules (policy_version_id, intent, mode)
        values (vid, i, 'auto');
      end loop;
      insert into public.active_evidence_policy (market, policy_version_id)
      values (m, vid)
      on conflict (market) do nothing;
    end if;
  end loop;
end $$;

-- ── RLS: owner-read, service-role writes ─────────────────────────────────────
do $$
declare t text;
begin
  foreach t in array array[
    'evidence_policy_versions','active_evidence_policy','evidence_policy_rules',
    'provider_runtime_config','provider_capability_status','evidence_policy_evaluations'
  ] loop
    execute format('alter table public.%I enable row level security', t);
    execute format($f$
      drop policy if exists %1$s_owner_read on public.%1$s;
      create policy %1$s_owner_read on public.%1$s
        for select to authenticated
        using (((select auth.jwt()) ->> 'email') = 'vterminater@gmail.com');
    $f$, t);
    execute format('grant select on table public.%I to authenticated', t);
  end loop;
end $$;
