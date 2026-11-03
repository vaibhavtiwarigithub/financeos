-- Register rejected historical trials with the same server fingerprint as the
-- config constructor. Existing table/lock/append-only ledger are reused.
create or replace function public.register_strategy_template_trial(
  p_market text,p_template_ids uuid[],p_kind text,p_operator text,p_weights jsonb,
  p_rule_version text,p_trial_family_id text,p_rule_spec jsonb,p_evaluation_as_of date
) returns jsonb language plpgsql security invoker set search_path = '' as $$
declare
  v_ids uuid[];v_fingerprint text;v_registration record;v_cutoff text;
begin
  if p_market not in ('us','india') or p_kind not in ('template','combination')
    or p_rule_spec->>'market' is distinct from p_market
    or p_rule_spec->>'ruleVersion' is distinct from p_rule_version
    or p_evaluation_as_of is null or p_evaluation_as_of > current_date then
    raise exception 'invalid pre-screen trial contract';
  end if;
  select array_agg(distinct x order by x) into v_ids from unnest(p_template_ids) x;
  if coalesce(cardinality(v_ids),0) not between 1 and 3 then raise exception 'invalid source template count'; end if;
  v_fingerprint := encode(sha256(convert_to(jsonb_build_object(
    'market',p_market,'template_ids',to_jsonb(v_ids),'kind',p_kind,'operator',p_operator,
    'weights',coalesce(p_weights,'{}'::jsonb),'rule_version',p_rule_version,
    'trial_family_id',p_trial_family_id,'rule_spec',p_rule_spec
  )::text,'UTF8')),'hex');
  select * into v_registration from public.register_trial(
    p_trial_family_id,v_fingerprint,case when p_kind='combination' then 'combination' else 'rule' end,
    coalesce(p_rule_spec->>'label','strategy trial'),
    jsonb_build_object('market',p_market,'template_ids',to_jsonb(v_ids),'rule_spec',p_rule_spec,
      'evaluation_as_of',p_evaluation_as_of),
    'autonomous_discovery','reference-seeds-confirmation-v1',array_to_string(v_ids,','));
  select spec->>'evaluation_as_of' into v_cutoff from public.trial_family_ledger
    where trial_family_id=p_trial_family_id and spec_fingerprint=v_fingerprint;
  if coalesce(v_cutoff,'') !~ '^\d{4}-\d{2}-\d{2}$' then raise exception 'historical cutoff unavailable'; end if;
  return jsonb_build_object('fingerprint',v_fingerprint,'evaluation_as_of',v_cutoff,
    'trial_index',v_registration.trial_index,'trials_considered',v_registration.trials_considered,
    'was_new',v_registration.was_new);
end $$;
revoke all on function public.register_strategy_template_trial(text,uuid[],text,text,jsonb,text,text,jsonb,date) from public,anon,authenticated;
grant execute on function public.register_strategy_template_trial(text,uuid[],text,text,jsonb,text,text,jsonb,date) to service_role;

-- pgcrypto lives in extensions, outside the constructor's pinned search_path.
-- Preserve the existing constructor contract, ACL, and server fingerprint.
do $$ declare v_definition text;v_crypto_schema text; begin
  select n.nspname into v_crypto_schema from pg_extension e join pg_namespace n on n.oid=e.extnamespace where e.extname='pgcrypto';
  if v_crypto_schema is null then raise exception 'pgcrypto dependency missing'; end if;
  v_definition := pg_get_functiondef('public.create_strategy_template_shadow_config(text,uuid[],text,text,jsonb,text,text,jsonb,text,jsonb)'::regprocedure);
  if position('encode(digest(' in v_definition)>0 then
    execute replace(v_definition,'encode(digest(',format('encode(%I.digest(',v_crypto_schema));
  elsif position(format('encode(%I.digest(',v_crypto_schema) in v_definition)=0 then
    raise exception 'unexpected strategy fingerprint constructor; review required';
  end if;
end $$;

alter function public.strategy_template_shadow_configs_immutable() set search_path = '';
alter function public.strategy_template_shadow_events_append_only() set search_path = '';
alter function public.strategy_template_shadow_state_guard() set search_path = '';
alter function public.strategy_template_paper_evaluations_append_only() set search_path = '';
alter function public.strategy_template_paper_selection_no_direct_write() set search_path = '';
notify pgrst,'reload schema';
