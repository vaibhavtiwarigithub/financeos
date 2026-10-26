-- A saved owner's smaller PAPER operating sublimit must survive concurrent doors.
do $migration$
declare v_oid oid; v_def text; v_anchor text := '  if v_used+p_cost>v_nav*0.05 then';
begin
  v_oid:='public.leveraged_paper_admission_guard(text,text,text,numeric,numeric,numeric,timestamptz,numeric,numeric)'::regprocedure;
  v_def:=pg_get_functiondef(v_oid);
  if position('allocation_profile_limit_v1' in v_def)>0 then return; end if;
  if (length(v_def)-length(replace(v_def,v_anchor,'')))/length(v_anchor)<>1
    or position('v_max_positions integer;' in v_def)=0 or position('for update;' in v_def)=0 then
    raise exception 'unexpected leveraged admission guard shape';
  end if;
  v_def:=replace(v_def,'v_max_positions integer;','v_max_positions integer; v_profile_text text; v_profile jsonb; v_profile_max numeric;');
  v_def:=replace(v_def,v_anchor,$guard$
  -- allocation_profile_limit_v1, checked after the existing shared pool lock.
  select value into v_profile_text from public.app_settings where key='paper_allocation:us';
  if v_profile_text is not null then
    begin v_profile:=v_profile_text::jsonb;
    exception when others then return jsonb_build_object('ok',false,'error','allocation_policy_unavailable'); end;
    if v_profile->>'version' is distinct from 'allocation_presets_v1_20261026'
      or v_profile->>'market' is distinct from 'us' or jsonb_typeof(v_profile->'enabled') is distinct from 'boolean' then
      return jsonb_build_object('ok',false,'error','allocation_policy_unavailable');
    end if;
    if (v_profile->>'enabled')::boolean then
      if jsonb_typeof(v_profile->'leveragedMaxPct') is distinct from 'number' then
        return jsonb_build_object('ok',false,'error','allocation_policy_unavailable');
      end if;
      v_profile_max:=(v_profile->>'leveragedMaxPct')::numeric;
      if v_profile_max<0 or v_profile_max>5 then return jsonb_build_object('ok',false,'error','allocation_policy_unavailable'); end if;
      if v_used+p_cost>v_nav*v_profile_max/100 then
        return jsonb_build_object('ok',false,'error','allocation_leveraged_limit',
          'profile',v_profile->>'profile','revision',v_profile->'revision','max_pct',v_profile_max);
      end if;
    end if;
  end if;
  if v_used+p_cost>v_nav*0.05 then$guard$);
  execute v_def;
end $migration$;
