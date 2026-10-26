-- Reserve unused US PAPER leveraged capacity under the existing pool row lock.
-- CLI-generated draft timestamp aligned to the verified MCP-applied ledger version.
-- No new signature, grant, table, live setting or historical financial write.
do $migration$
declare
  v_oid oid;
  v_def text;
  v_anchor text := E'  select app_paused, trading_enabled';
  v_names text := E'    select count(*) into v_open_names\n      from public.paper_positions\n      where market = p_market and position_role = ''alpha'';';
begin
  select p.oid into strict v_oid from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    where n.nspname='public' and p.proname='execute_paper_fill';
  v_def := pg_get_functiondef(v_oid);
  if position('paper_sleeve_liquidity_v1' in v_def)>0 then
    if position('count(distinct upper(btrim(symbol)))' in v_def)=0 then raise exception 'incomplete liquidity contract'; end if;
    return;
  end if;
  if (length(v_def)-length(replace(v_def,v_anchor,'')))/length(v_anchor)<>1
    or (length(v_def)-length(replace(v_def,v_names,'')))/length(v_names)<>1
    or position('where market = p_market for update;' in v_def)=0
    or position('  v_cash numeric;' in v_def)=0 then
    raise exception 'unexpected paper fill shape; liquidity guard not applied';
  end if;
  v_def := replace(v_def, '  v_cash numeric;', E'  v_cash numeric;\n  v_liquidity_nav numeric;\n  v_liquidity_leveraged numeric;\n  v_liquidity_reserve numeric;');
  v_def := replace(v_def, v_anchor, $guard$
  -- paper_sleeve_liquidity_v1: the caller cannot spend a stale cash snapshot.
  -- Top-ups and atomic rotations call this same function and inherit the guard.
  if p_market = 'us' then
    if v_cash is null or v_cash::text in ('NaN','Infinity','-Infinity') or v_cash<0
      or p_total_cost is null or p_total_cost::text in ('NaN','Infinity','-Infinity') then
      return jsonb_build_object('ok',false,'error','invalid_liquidity_accounting');
    end if;
    if exists(select 1 from public.paper_positions where market=p_market and
      (qty is null or qty::text in ('NaN','Infinity','-Infinity') or qty<0
       or (qty>0 and (coalesce(case when current_price>0 then current_price else avg_cost end,0)<=0
         or coalesce(case when current_price>0 then current_price else avg_cost end,0)::text in ('NaN','Infinity','-Infinity'))))) then
      return jsonb_build_object('ok',false,'error','invalid_liquidity_position_mark');
    end if;
    select v_cash + coalesce(sum(qty * case when current_price>0 then current_price else avg_cost end),0),
      coalesce(sum(qty * case when current_price>0 then current_price else avg_cost end)
        filter(where upper(btrim(symbol)) in ('SOXL','SOXS','TQQQ','SQQQ')),0)
      into v_liquidity_nav,v_liquidity_leveraged
      from public.paper_positions where market=p_market and qty>0;
    if v_liquidity_nav<=0 then return jsonb_build_object('ok',false,'error','invalid_liquidity_nav'); end if;
    v_liquidity_reserve := greatest(0, v_liquidity_nav*0.05-v_liquidity_leveraged);
    if v_cash-p_total_cost < v_liquidity_reserve-0.00000001 then
      return jsonb_build_object('ok',false,'error','leveraged_liquidity_reserved',
        'policy_version','paper_sleeve_liquidity_v1','reserve',v_liquidity_reserve,
        'available_cash',v_cash,'ordinary_deployable_cash',greatest(0,v_cash-v_liquidity_reserve));
    end if;
  end if;

  select app_paused, trading_enabled$guard$);
  v_def := replace(v_def, v_names, E'    select count(distinct upper(btrim(symbol))) into v_open_names\n      from public.paper_positions\n      where market = p_market and qty > 0;');
  execute v_def;
end $migration$;
