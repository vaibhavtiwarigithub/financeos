-- Close the remaining Evidence Router API surface and retain adapter-level
-- provenance in the canonical cache. This follows the broader 20260715120000
-- security repair and is intentionally forward-only.

alter table public.evidence_cache_v2
  add column if not exists provenance jsonb not null default '[]'::jsonb;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'evidence_cache_v2_provenance_array'
      and conrelid = 'public.evidence_cache_v2'::regclass
  ) then
    alter table public.evidence_cache_v2
      add constraint evidence_cache_v2_provenance_array
      check (jsonb_typeof(provenance) = 'array');
  end if;
end
$$;

revoke execute on function public.activate_evidence_policy(text, uuid, text[], uuid) from public, anon, authenticated;
revoke execute on function public.create_evidence_policy_version(text, jsonb, text, uuid) from public, anon, authenticated;
revoke execute on function public.claim_provider_refresh_jobs(integer, integer) from public, anon, authenticated;
revoke execute on function public.try_acquire_provider_slot(text, integer) from public, anon, authenticated;

grant execute on function public.activate_evidence_policy(text, uuid, text[], uuid) to service_role;
grant execute on function public.create_evidence_policy_version(text, jsonb, text, uuid) to service_role;
grant execute on function public.claim_provider_refresh_jobs(integer, integer) to service_role;
grant execute on function public.try_acquire_provider_slot(text, integer) to service_role;

alter function public.activate_evidence_policy(text, uuid, text[], uuid) set search_path = public;
alter function public.create_evidence_policy_version(text, jsonb, text, uuid) set search_path = public;
alter function public.claim_provider_refresh_jobs(integer, integer) set search_path = public;
alter function public.try_acquire_provider_slot(text, integer) set search_path = public;

-- Direct client access could starve or bypass provider leases.
alter table public.provider_pacing enable row level security;
revoke all on table public.provider_pacing from public, anon, authenticated;
grant all on table public.provider_pacing to service_role;
