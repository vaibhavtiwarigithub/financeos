-- Complete the common transaction boundary before activation: preserve the
-- market's configured total-symbol limit and enforce the v3 price/R:R contract.
do $migration$
declare v_oid oid; v_def text; v_anchor text := '  if p_cost<v_nav*0.005 then';
begin
  v_oid := 'public.leveraged_paper_admission_guard(text,text,text,numeric,numeric,numeric,timestamptz,numeric,numeric)'::regprocedure;
  v_def := pg_get_functiondef(v_oid);
  if position('reward_risk_below_minimum' in v_def)>0 then return; end if;
  if (length(v_def)-length(replace(v_def,v_anchor,'')))/length(v_anchor)<>1
    or position('v_opposite text;' in v_def)=0 or position('interval ''15 minutes''' in v_def)=0 then
    raise exception 'unexpected admission guard shape';
  end if;
  v_def:=replace(v_def,'v_opposite text;','v_opposite text; v_max_positions integer;');
  v_def:=replace(v_def,'interval ''15 minutes''','interval ''2 minutes''');
  v_def:=replace(v_def,v_anchor, $body$
  if p_target-p_price < 2*(p_price-p_stop) then
    return jsonb_build_object('ok',false,'error','reward_risk_below_minimum');
  end if;
  select max_open_positions into v_max_positions from public.trading_mandates where market=p_market;
  if v_max_positions is null or v_max_positions<1 then
    return jsonb_build_object('ok',false,'error','mandate_unavailable');
  end if;
  if not exists(select 1 from public.paper_positions where market=p_market and symbol=p_symbol and qty>0)
    and (select count(distinct symbol) from public.paper_positions where market=p_market and qty>0)>=v_max_positions then
    return jsonb_build_object('ok',false,'error','max_positions_reached');
  end if;
  if p_cost<v_nav*0.005 then$body$);
  execute v_def;
end $migration$;
