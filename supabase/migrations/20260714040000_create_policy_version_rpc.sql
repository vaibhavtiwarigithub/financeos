-- Canonical Evidence Router — Phase 2 foundation (create-version RPC).
--
-- Atomic creation of a new immutable per-market policy VERSION plus all its rule
-- rows in ONE transaction. The version number is allocated under a per-market
-- advisory lock so two concurrent creators can never collide on (market,version).
-- This RPC ONLY writes policy metadata — it NEVER activates the version (the
-- active pointer is untouched), never runs a research run, never calls a
-- provider, and never touches scoring, orders, cash, or the money path.
--
-- The API layer (owner-gated) does full semantic validation before calling this;
-- the table CHECK constraints (mode enum, provider-shape, stale>=fresh) remain
-- the last line of defense. service_role only.

create or replace function public.create_evidence_policy_version(
  p_market text,
  p_rules  jsonb,
  p_note   text default null,
  p_actor  uuid default null
) returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_version int;
  v_id      uuid;
  r         jsonb;
begin
  if p_market not in ('us','india') then
    raise exception 'invalid market %', p_market;
  end if;
  if p_rules is null or jsonb_typeof(p_rules) <> 'array' or jsonb_array_length(p_rules) = 0 then
    raise exception 'p_rules must be a non-empty json array';
  end if;

  -- Per-market advisory lock so the max(version)+1 allocation is race-free.
  perform pg_advisory_xact_lock(hashtext('evidence_policy_create:' || p_market));

  select coalesce(max(version), 0) + 1 into v_version
  from public.evidence_policy_versions
  where market = p_market;

  insert into public.evidence_policy_versions (market, version, router_enabled, created_by, change_note)
  values (p_market, v_version, false, p_actor, p_note)
  returning id into v_id;

  for r in select * from jsonb_array_elements(p_rules)
  loop
    insert into public.evidence_policy_rules (
      policy_version_id, intent, mode, preferred_provider,
      max_age_seconds, stale_max_seconds, max_sync_attempts
    ) values (
      v_id,
      r->>'intent',
      coalesce(r->>'mode', 'auto'),
      r->>'preferred_provider',
      coalesce((r->>'max_age_seconds')::int, 86400),
      coalesce((r->>'stale_max_seconds')::int, 259200),
      coalesce((r->>'max_sync_attempts')::int, 2)
    );
  end loop;

  return v_id;
end $$;

revoke all on function public.create_evidence_policy_version(text, jsonb, text, uuid) from public;
grant execute on function public.create_evidence_policy_version(text, jsonb, text, uuid) to service_role;
