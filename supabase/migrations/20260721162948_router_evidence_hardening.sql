-- Router evidence hardening. This migration does not enable the router.
-- It separates safety from parity quality, schedules cache-only cohort
-- evaluation, and requires a rolling ten-session proof before future cutover.

alter table public.evidence_policy_evaluations
  add column if not exists safety_pass boolean not null default false,
  add column if not exists quality_pass boolean not null default false,
  add column if not exists market_session_date date;

comment on column public.evidence_policy_evaluations.safety_pass is
  'True only when semantic, field-loss, eligibility, and no-extra-provider-call safety gates pass.';
comment on column public.evidence_policy_evaluations.quality_pass is
  'True only when optional coverage, score drift, and ranking-parity quality gates pass.';
comment on column public.evidence_policy_evaluations.market_session_date is
  'Market session represented by frozen daily bars; weekends and holidays cannot inflate rolling proof.';

create index if not exists evidence_policy_eval_rolling_gate_idx
  on public.evidence_policy_evaluations
    (market, candidate_version_id, baseline_version_id, evaluation_code_version, strategy_version, market_session_date desc)
  where passed and safety_pass and quality_pass;

-- Create one inert, router-enabled candidate per market from the exact active
-- rule set. It is NOT activated here. Cohort evidence must bind to the candidate
-- that could eventually be activated; evidence against the disabled baseline
-- cannot authorize a different policy ID.
do $$
declare
  v_market text;
  v_active uuid;
  v_candidate uuid;
  v_version int;
begin
  foreach v_market in array array['us', 'india']
  loop
    if not exists (
      select 1 from public.evidence_policy_versions
      where market = v_market and router_enabled
    ) then
      perform pg_advisory_xact_lock(hashtext('evidence_policy_create:' || v_market));
      select policy_version_id into v_active
      from public.active_evidence_policy where market = v_market;
      if v_active is null then raise exception 'missing active evidence policy for %', v_market; end if;

      select coalesce(max(version), 0) + 1 into v_version
      from public.evidence_policy_versions where market = v_market;
      insert into public.evidence_policy_versions (market, version, router_enabled, change_note)
      values (v_market, v_version, true, 'inert cutover candidate; activation requires rolling evidence gate')
      returning id into v_candidate;

      insert into public.evidence_policy_rules (
        policy_version_id, intent, mode, preferred_provider,
        max_age_seconds, stale_max_seconds, max_sync_attempts, advanced_config
      )
      select v_candidate, intent, mode, preferred_provider,
             max_age_seconds, stale_max_seconds, max_sync_attempts, advanced_config
      from public.evidence_policy_rules
      where policy_version_id = v_active;
    end if;
  end loop;
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
  v_passing_sessions int;
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
  if not v_eval.passed or not v_eval.safety_pass or not v_eval.quality_pass then
    raise exception 'evaluation % did not pass both safety and quality gates', p_evaluation_id;
  end if;
  if v_eval.market_session_date is null then raise exception 'evaluation % has no market session date', p_evaluation_id; end if;
  if v_eval.expires_at is null or v_eval.expires_at <= now() then raise exception 'evaluation % is expired', p_evaluation_id; end if;
  if cardinality(v_eval.required_intents) = 0
     or not (v_eval.required_intents @> p_required_intents and v_eval.required_intents <@ p_required_intents) then
    raise exception 'required intent set does not match the evaluated set';
  end if;

  -- The selected evaluation must be fresh (checked above). Historical session
  -- proofs may be expired individually; requiring all ten to fit inside the
  -- 72-hour TTL would make the rolling gate impossible to satisfy.
  select count(distinct e.market_session_date)
  into v_passing_sessions
  from public.evidence_policy_evaluations e
  where e.market = p_market
    and e.candidate_version_id = p_candidate_version_id
    and e.baseline_version_id is not distinct from p_baseline_version_id
    and e.evaluation_code_version = p_evaluation_code_version
    and e.strategy_version = p_strategy_version
    and e.passed and e.safety_pass and e.quality_pass
    and e.market_session_date is not null
    and e.market_session_date <= v_eval.market_session_date
    and e.market_session_date >= v_eval.market_session_date - 45;
  if v_passing_sessions < 10 then
    raise exception 'router cutover requires 10 distinct passing market sessions; found %', v_passing_sessions;
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

revoke all on function public.activate_evidence_policy_bound(text, uuid, uuid, uuid, text, text, text[], uuid)
  from public, anon, authenticated;
grant execute on function public.activate_evidence_policy_bound(text, uuid, uuid, uuid, text, text, text[], uuid)
  to service_role;

-- Cohorts run once after each market's final daily shadow tick. The route itself
-- is cache-only, so these jobs consume no external-provider quota.
do $$
declare v_jobid bigint;
begin
  select jobid into v_jobid from cron.job where jobname = 'kairos-evidence-cohort-us';
  if v_jobid is not null then perform cron.unschedule(v_jobid); end if;
  select jobid into v_jobid from cron.job where jobname = 'kairos-evidence-cohort-india';
  if v_jobid is not null then perform cron.unschedule(v_jobid); end if;
end $$;

select cron.schedule(
  'kairos-evidence-cohort-us',
  '5 15 * * *',
  $$select public.kairos_call_agent('/api/agents/evidence-cohort?market=us&limit=50', '{}'::jsonb, 'POST', 55000)$$
);

select cron.schedule(
  'kairos-evidence-cohort-india',
  '5 5 * * *',
  $$select public.kairos_call_agent('/api/agents/evidence-cohort?market=india&limit=50', '{}'::jsonb, 'POST', 55000)$$
);
