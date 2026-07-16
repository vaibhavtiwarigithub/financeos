-- Close router-cutover activation gaps found during adversarial review.
--
-- 1. Bind the required-intent set into the immutable evaluation proof.
-- 2. Keep machine safety (`passed`) separate from owner disposition.
-- 3. Require one attributable, immutable disposition per reviewed symbol.
-- 4. Prevent the legacy pointer-swap RPC from activating router-enabled versions.

alter table public.evidence_policy_evaluations
  add column if not exists required_intents text[];

update public.evidence_policy_evaluations
set required_intents = array[]::text[]
where required_intents is null;

alter table public.evidence_policy_evaluations
  alter column required_intents set not null;

alter table public.evidence_evaluation_reviews
  alter column reviewer set not null;

create unique index if not exists evidence_eval_reviews_symbol_uidx
  on public.evidence_evaluation_reviews (evaluation_id, symbol)
  where symbol is not null;

-- Shadow-policy selection may use this legacy RPC only while the target remains
-- inert. An enabled target must pass the fully-bound activation RPC below.
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
declare
  v_market text;
  v_router_enabled boolean;
  missing text;
begin
  if p_market not in ('us','india') then
    raise exception 'invalid market %', p_market;
  end if;
  perform pg_advisory_xact_lock(hashtext('evidence_policy_activate:' || p_market));

  select market, router_enabled into v_market, v_router_enabled
  from public.evidence_policy_versions where id = p_version_id;
  if v_market is null then raise exception 'unknown policy version %', p_version_id; end if;
  if v_market <> p_market then
    raise exception 'version % is market % not %', p_version_id, v_market, p_market;
  end if;
  if v_router_enabled then
    raise exception 'router-enabled version % requires activate_evidence_policy_bound()', p_version_id;
  end if;
  if coalesce(cardinality(p_required_intents), 0) = 0 then
    raise exception 'required intent set must not be empty';
  end if;

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
  v_eval record;
  v_active uuid;
  v_market text;
  v_router_enabled boolean;
  v_unreviewed int;
begin
  if p_market not in ('us','india') then raise exception 'invalid market %', p_market; end if;
  if coalesce(cardinality(p_required_intents), 0) = 0 then raise exception 'required intent set must not be empty'; end if;
  perform pg_advisory_xact_lock(hashtext('evidence_policy_activate:' || p_market));

  select * into v_eval from public.evidence_policy_evaluations where id = p_evaluation_id;
  if v_eval is null then raise exception 'unknown evaluation %', p_evaluation_id; end if;
  if v_eval.market <> p_market then raise exception 'evaluation market mismatch'; end if;
  if v_eval.candidate_version_id <> p_candidate_version_id then raise exception 'evaluation candidate mismatch'; end if;
  if v_eval.baseline_version_id is distinct from p_baseline_version_id then raise exception 'evaluation baseline mismatch'; end if;
  if v_eval.evaluation_code_version is distinct from p_evaluation_code_version then raise exception 'evaluation code version mismatch'; end if;
  if v_eval.strategy_version is distinct from p_strategy_version then raise exception 'evaluation strategy version mismatch'; end if;
  if not v_eval.passed then raise exception 'evaluation % did not pass machine gates', p_evaluation_id; end if;
  if v_eval.expires_at is null or v_eval.expires_at <= now() then raise exception 'evaluation % is expired', p_evaluation_id; end if;
  if cardinality(v_eval.required_intents) = 0
     or not (v_eval.required_intents @> p_required_intents and v_eval.required_intents <@ p_required_intents) then
    raise exception 'required intent set does not match the evaluated set';
  end if;

  select policy_version_id into v_active from public.active_evidence_policy where market = p_market;
  if v_active is distinct from p_baseline_version_id then
    raise exception 'evaluated baseline is no longer active for %', p_market;
  end if;

  if jsonb_array_length(coalesce(v_eval.requires_owner_review, '[]'::jsonb)) > 0 and p_actor is null then
    raise exception 'reviewed divergences require an attributable owner actor';
  end if;
  select count(*) into v_unreviewed
  from jsonb_array_elements(coalesce(v_eval.requires_owner_review, '[]'::jsonb)) r
  where not exists (
    select 1 from public.evidence_evaluation_reviews rev
    where rev.evaluation_id = p_evaluation_id
      and rev.symbol = (r ->> 'symbol')
      and rev.disposition = 'approved'
      and rev.reviewer = p_actor
  );
  if v_unreviewed > 0 then raise exception 'evaluation % has % unapproved divergence(s)', p_evaluation_id, v_unreviewed; end if;

  select market, router_enabled into v_market, v_router_enabled
  from public.evidence_policy_versions where id = p_candidate_version_id;
  if v_market is null then raise exception 'unknown policy version %', p_candidate_version_id; end if;
  if v_market <> p_market then raise exception 'candidate market mismatch'; end if;
  if not v_router_enabled then raise exception 'bound cutover requires a router-enabled candidate'; end if;
  if exists (
    select 1 from unnest(p_required_intents) ri
    where not exists (
      select 1 from public.evidence_policy_rules r
      where r.policy_version_id = p_candidate_version_id and r.intent = ri
    )
  ) then raise exception 'candidate is missing required intent rules'; end if;

  insert into public.active_evidence_policy (market, policy_version_id, activated_by, activated_at)
  values (p_market, p_candidate_version_id, p_actor, now())
  on conflict (market) do update
    set policy_version_id = excluded.policy_version_id,
        activated_by = excluded.activated_by,
        activated_at = now();
end $$;

revoke all on function public.activate_evidence_policy(text, uuid, text[], uuid) from public, anon, authenticated;
grant execute on function public.activate_evidence_policy(text, uuid, text[], uuid) to service_role;
revoke all on function public.activate_evidence_policy_bound(text, uuid, uuid, uuid, text, text, text[], uuid) from public, anon, authenticated;
grant execute on function public.activate_evidence_policy_bound(text, uuid, uuid, uuid, text, text, text[], uuid) to service_role;
