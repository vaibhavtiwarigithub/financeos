-- Defense in depth for the Evidence Router. RLS already limits reads and blocks
-- client writes, but Supabase default table grants should not remain a second,
-- latent access path if RLS is ever changed incorrectly.

do $$
declare
  t text;
begin
  foreach t in array array[
    'evidence_policy_versions',
    'active_evidence_policy',
    'evidence_policy_rules',
    'provider_runtime_config',
    'provider_capability_status',
    'evidence_policy_evaluations',
    'evidence_cache_v2',
    'provider_call_ledger',
    'provider_refresh_jobs'
  ] loop
    execute format('revoke all on table public.%I from anon', t);
    execute format(
      'revoke insert, update, delete, truncate, references, trigger on table public.%I from authenticated',
      t
    );
    execute format('grant select on table public.%I to authenticated', t);
    execute format('grant all on table public.%I to service_role', t);
  end loop;
end
$$;
