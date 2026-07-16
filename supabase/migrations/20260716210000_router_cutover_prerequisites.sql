-- Canonical Evidence Router — CUTOVER PREREQUISITES (router-cutover §4/§5/§6/§10).
--
-- This migration builds the machinery that MUST EXIST BEFORE any owner-approved
-- cutover. It DOES NOT CUT OVER: no policy version is created, no router_enabled
-- is flipped, no active pointer moves. Both markets remain router_enabled=false.
--
-- Adds:
--   1. evidence_field_baselines      — last ACCEPTED per-symbol field mask (mutable)
--   2. evidence_degradation_events   — append-only runtime guard evidence (§6)
--   3. evidence_evaluation_details   — append-only per-symbol dual-run deltas (§10)
--   4. evidence_evaluation_reviews   — append-only owner disposition of divergences
--   5. evidence_policy_evaluations   — frozen-cohort/binding columns (§10)
--   6. activate_evidence_policy_bound() — activation bound to an exact, fresh
--      evaluation (§5). A stale evaluation cannot authorize a policy.
--
-- RLS owner-read, service-role writes only, fixed search_path on RPCs, grants
-- exclude anon/authenticated, evidence rows are append-only.

-- ── 1. accepted baseline masks (§6.2) ────────────────────────────────────────
-- MUTABLE by design: this is "the last accepted baseline", a moving reference
-- point, not evidence. The evidence of every comparison against it is the
-- append-only events table below.
create table if not exists public.evidence_field_baselines (
  market             text not null check (market in ('us','india')),
  symbol             text not null,
  mask               jsonb not null,
  policy_version_id  uuid references public.evidence_policy_versions(id),
  evidence_run_id    text,
  guard_code_version text not null,
  accepted_at        timestamptz not null default now(),
  primary key (market, symbol)
);

comment on table public.evidence_field_baselines is
  'Last ACCEPTED per-symbol evidence availability/quality mask, per market. Only a clean (non-degraded) run may be promoted here, so a degraded run can never silently become the new normal. Market-local: US masks are never evidence for India.';

-- ── 2. runtime degradation events (§6, append-only) ──────────────────────────
create table if not exists public.evidence_degradation_events (
  id                 uuid primary key default gen_random_uuid(),
  market             text not null check (market in ('us','india')),
  symbol             text not null,
  evidence_run_id    text,
  policy_version_id  uuid references public.evidence_policy_versions(id),
  guard_mode         text not null check (guard_mode in ('off','measure_only','enforce')),
  guard_code_version text not null,
  action             text not null check (action in ('allow','abstain_new_long')),
  blocking_codes     text[] not null default '{}',
  proposed_direction text check (proposed_direction in ('long','neutral','short')),
  applied_direction  text check (applied_direction in ('long','neutral','short')),
  baseline_mask      jsonb,
  current_mask       jsonb,
  transitions        jsonb,
  created_at         timestamptz not null default now(),
  -- The guard is STRICTLY SUBTRACTIVE: it may only turn a long into a neutral.
  -- Enforced in the schema so no future code path can persist a guard event
  -- that created or upgraded an entry, whatever the application layer believes.
  constraint degradation_guard_is_subtractive check (
    applied_direction is null
    or proposed_direction is null
    or applied_direction = proposed_direction
    or (proposed_direction = 'long' and applied_direction = 'neutral')
  )
);

create index if not exists evidence_degradation_market_run_idx
  on public.evidence_degradation_events (market, evidence_run_id, created_at desc);
create index if not exists evidence_degradation_symbol_idx
  on public.evidence_degradation_events (market, symbol, created_at desc);

comment on table public.evidence_degradation_events is
  'Append-only proof of every runtime evidence-degradation abstain: baseline vs current mask, classified transitions, reason codes, policy/run IDs, and the guard mode in force. An outage may never suppress an exit — only a NEW long.';

-- ── 3. per-symbol dual-run deltas (§4, §10 — append-only) ────────────────────
-- §10: "Do not store only aggregate eligibility_flips."
create table if not exists public.evidence_evaluation_details (
  id                    uuid primary key default gen_random_uuid(),
  evaluation_id         uuid not null references public.evidence_policy_evaluations(id) on delete restrict,
  market                text not null check (market in ('us','india')),
  symbol                text not null,
  symbol_shape          text not null check (symbol_shape in ('equity','etf','adr','metal')),
  is_held               boolean not null default false,
  legacy_status         text not null check (legacy_status in ('scored','abstained','failed')),
  candidate_status      text not null check (candidate_status in ('scored','abstained','failed')),
  legacy_score          numeric,
  candidate_score       numeric,
  score_delta           numeric,
  legacy_rank           int,
  candidate_rank        int,
  rank_delta            int,
  legacy_direction      text,
  candidate_direction   text,
  legacy_eligible       boolean not null,
  candidate_eligible    boolean not null,
  flip                  text not null check (flip in ('none','ineligible_to_eligible','eligible_to_ineligible')),
  flip_cause            text not null check (flip_cause in (
                          'none','genuine_value_change','source_availability','stale_fallback',
                          'field_omission','conflict_resolution','basis_mapping',
                          'weight_renormalization','unexplained')),
  blocking              boolean not null default false,
  -- Per-field semantic/quality/availability deltas with evidence fingerprints.
  field_deltas          jsonb not null,
  legacy_included_dims  text[] not null default '{}',
  candidate_included_dims text[] not null default '{}',
  note                  text,
  created_at            timestamptz not null default now()
);

create index if not exists evidence_eval_details_eval_idx
  on public.evidence_evaluation_details (evaluation_id, symbol);
create index if not exists evidence_eval_details_flip_idx
  on public.evidence_evaluation_details (evaluation_id, flip) where flip <> 'none';

comment on table public.evidence_evaluation_details is
  'Append-only per-symbol dual-run delta: field/quality/availability/score/rank/direction/eligibility before-and-after with a bounded flip cause. Includes rows where EITHER path abstained or failed — comparing only jointly-successful rows is how an availability-driven flip hides.';

-- ── 4. owner disposition of divergences (append-only) ────────────────────────
-- evidence_policy_evaluations is append-only, so reviewer disposition lands in
-- its own append-only child rather than mutating the proof.
create table if not exists public.evidence_evaluation_reviews (
  id             uuid primary key default gen_random_uuid(),
  evaluation_id  uuid not null references public.evidence_policy_evaluations(id) on delete restrict,
  symbol         text,
  disposition    text not null check (disposition in ('approved','rejected','deferred')),
  reviewer       uuid,
  reviewer_note  text not null,
  created_at     timestamptz not null default now()
);

create index if not exists evidence_eval_reviews_eval_idx
  on public.evidence_evaluation_reviews (evaluation_id, symbol);

-- ── 5. frozen-cohort + binding columns on the evaluation proof (§10) ─────────
alter table public.evidence_policy_evaluations
  add column if not exists cohort_fingerprint      text,
  add column if not exists universe_snapshot_id    text,
  add column if not exists as_of                   timestamptz,
  add column if not exists strategy_version        text,
  add column if not exists strategy_fingerprint    text,
  add column if not exists evaluation_code_version text,
  add column if not exists price_basis             text,
  add column if not exists score_threshold         numeric,
  add column if not exists counts                  jsonb,
  add column if not exists coverage                jsonb,
  add column if not exists failures                jsonb,
  add column if not exists requires_owner_review   jsonb,
  add column if not exists outage_drills           jsonb,
  add column if not exists expires_at              timestamptz;

comment on column public.evidence_policy_evaluations.expires_at is
  'Evaluation validity horizon. activate_evidence_policy_bound() refuses an expired evaluation: a stale evaluation cannot authorize a policy.';
comment on column public.evidence_policy_evaluations.cohort_fingerprint is
  'Identity of the frozen cohort (universe/as-of/policies/strategy/threshold/price basis/code version). Changing any frozen input changes this and invalidates the approval.';

-- ── append-only enforcement on the new evidence tables ───────────────────────
drop trigger if exists no_mutate on public.evidence_degradation_events;
create trigger no_mutate before update or delete on public.evidence_degradation_events
  for each row execute function public.evidence_block_mutation();

drop trigger if exists no_mutate on public.evidence_evaluation_details;
create trigger no_mutate before update or delete on public.evidence_evaluation_details
  for each row execute function public.evidence_block_mutation();

drop trigger if exists no_mutate on public.evidence_evaluation_reviews;
create trigger no_mutate before update or delete on public.evidence_evaluation_reviews
  for each row execute function public.evidence_block_mutation();

-- ── 6. activation bound to an exact, fresh evaluation (§5) ───────────────────
-- Binds approval to: candidate version + baseline version + evaluation ID +
-- evaluation code version + strategy version + market + expiry. Every one of
-- these is checked; any mismatch raises rather than activating.
--
-- This RPC does NOT create a policy version and cannot set router_enabled — it
-- only moves the active pointer to a version that already exists. Creating an
-- enabled version remains a separate, explicitly owner-approved act.
create or replace function public.activate_evidence_policy_bound(
  p_market                  text,
  p_candidate_version_id    uuid,
  p_baseline_version_id     uuid,
  p_evaluation_id           uuid,
  p_evaluation_code_version text,
  p_strategy_version        text,
  p_required_intents        text[],
  p_actor                   uuid default null
) returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_eval    record;
  v_active  uuid;
  v_market  text;
  v_unreviewed int;
begin
  if p_market not in ('us','india') then
    raise exception 'invalid market %', p_market;
  end if;

  -- Per-market lock. Markets activate INDEPENDENTLY — US progress is never
  -- evidence for India, and neither blocks the other.
  perform pg_advisory_xact_lock(hashtext('evidence_policy_activate:' || p_market));

  select * into v_eval
  from public.evidence_policy_evaluations
  where id = p_evaluation_id;
  if v_eval is null then
    raise exception 'unknown evaluation %', p_evaluation_id;
  end if;

  -- Bind every axis of the approval.
  if v_eval.market <> p_market then
    raise exception 'evaluation % is for market % not %', p_evaluation_id, v_eval.market, p_market;
  end if;
  if v_eval.candidate_version_id <> p_candidate_version_id then
    raise exception 'evaluation % evaluated candidate %, not %', p_evaluation_id, v_eval.candidate_version_id, p_candidate_version_id;
  end if;
  if v_eval.baseline_version_id is distinct from p_baseline_version_id then
    raise exception 'evaluation % used baseline %, not %', p_evaluation_id, v_eval.baseline_version_id, p_baseline_version_id;
  end if;
  if v_eval.evaluation_code_version is distinct from p_evaluation_code_version then
    raise exception 'evaluation % was produced by code version %, not %', p_evaluation_id, v_eval.evaluation_code_version, p_evaluation_code_version;
  end if;
  if v_eval.strategy_version is distinct from p_strategy_version then
    raise exception 'evaluation % froze strategy %, not %', p_evaluation_id, v_eval.strategy_version, p_strategy_version;
  end if;
  if not v_eval.passed then
    raise exception 'evaluation % did not pass its gates', p_evaluation_id;
  end if;
  if v_eval.expires_at is null or v_eval.expires_at <= now() then
    raise exception 'evaluation % is expired or has no expiry — a stale evaluation cannot authorize a policy', p_evaluation_id;
  end if;

  -- The baseline the evaluation compared against must still be the ACTIVE
  -- policy. If the world moved on, the evaluation describes a comparison that
  -- no longer exists.
  select policy_version_id into v_active from public.active_evidence_policy where market = p_market;
  if v_active is distinct from p_baseline_version_id then
    raise exception 'baseline % is not the active policy for % (active is %) — re-evaluate against the current baseline',
      p_baseline_version_id, p_market, coalesce(v_active::text, 'none');
  end if;

  -- Every divergence the evaluation flagged for owner review needs an explicit
  -- approving disposition. Added coverage is measured, never self-approving.
  select count(*) into v_unreviewed
  from jsonb_array_elements(coalesce(v_eval.requires_owner_review, '[]'::jsonb)) r
  where not exists (
    select 1 from public.evidence_evaluation_reviews rev
    where rev.evaluation_id = p_evaluation_id
      and rev.symbol = (r ->> 'symbol')
      and rev.disposition = 'approved'
  );
  if v_unreviewed > 0 then
    raise exception 'evaluation % has % divergence(s) awaiting owner review', p_evaluation_id, v_unreviewed;
  end if;

  -- Candidate must belong to this market and carry a rule for every required intent.
  select market into v_market from public.evidence_policy_versions where id = p_candidate_version_id;
  if v_market is null then raise exception 'unknown policy version %', p_candidate_version_id; end if;
  if v_market <> p_market then
    raise exception 'version % is market % not %', p_candidate_version_id, v_market, p_market;
  end if;
  if exists (
    select 1 from unnest(p_required_intents) ri
    where not exists (
      select 1 from public.evidence_policy_rules r
      where r.policy_version_id = p_candidate_version_id and r.intent = ri
    )
  ) then
    raise exception 'version % is missing rules for one or more required intents', p_candidate_version_id;
  end if;

  insert into public.active_evidence_policy (market, policy_version_id, activated_by, activated_at)
  values (p_market, p_candidate_version_id, p_actor, now())
  on conflict (market) do update
    set policy_version_id = excluded.policy_version_id,
        activated_by = excluded.activated_by,
        activated_at = now();
end $$;

revoke all on function public.activate_evidence_policy_bound(text, uuid, uuid, uuid, text, text, text[], uuid) from public;
revoke all on function public.activate_evidence_policy_bound(text, uuid, uuid, uuid, text, text, text[], uuid) from anon;
revoke all on function public.activate_evidence_policy_bound(text, uuid, uuid, uuid, text, text, text[], uuid) from authenticated;
grant execute on function public.activate_evidence_policy_bound(text, uuid, uuid, uuid, text, text, text[], uuid) to service_role;

-- ── RLS: owner-read, service-role writes ─────────────────────────────────────
do $$
declare t text;
begin
  foreach t in array array[
    'evidence_field_baselines','evidence_degradation_events',
    'evidence_evaluation_details','evidence_evaluation_reviews'
  ] loop
    execute format('alter table public.%I enable row level security', t);
    execute format($f$
      drop policy if exists %1$s_owner_read on public.%1$s;
      create policy %1$s_owner_read on public.%1$s
        for select to authenticated
        using (((select auth.jwt()) ->> 'email') = 'vterminater@gmail.com');
    $f$, t);
    -- No INSERT/UPDATE/DELETE policy for authenticated: writes are service-role
    -- only (service_role bypasses RLS). anon gets nothing at all.
    execute format('revoke all on table public.%I from anon, authenticated', t);
    execute format('grant select on table public.%I to authenticated', t);
  end loop;
end $$;
