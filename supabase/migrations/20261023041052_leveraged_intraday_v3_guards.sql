-- Additive provenance, no historical policy backfill or position mutation.
alter table public.paper_positions add column if not exists entry_policy_version text;

-- Shared transaction-time admission. The caller already holds this same book row;
-- the lock also makes this helper safe when called directly by service_role.
create or replace function public.leveraged_paper_admission_guard(
  p_symbol text, p_market text, p_currency text, p_qty numeric, p_price numeric,
  p_cost numeric, p_quote_at timestamptz, p_stop numeric, p_target numeric
) returns jsonb language plpgsql security invoker set search_path = '' as $$
declare v_nav numeric; v_cash numeric; v_used numeric; v_opposite text;
begin
  if p_symbol is null or p_symbol not in ('SOXL','SOXS','TQQQ','SQQQ') or p_market is distinct from 'us'
    or p_currency is distinct from 'USD' or p_qty is null or p_price is null or p_cost is null
    or p_stop is null or p_target is null
    or p_qty::text in ('NaN','Infinity','-Infinity') or p_price::text in ('NaN','Infinity','-Infinity')
    or p_cost::text in ('NaN','Infinity','-Infinity') or p_stop::text in ('NaN','Infinity','-Infinity')
    or p_target::text in ('NaN','Infinity','-Infinity') or p_qty<=0 or p_price<=0 or p_cost<=0
    or p_stop<=0 or p_stop>=p_price or p_target<=p_price or abs(p_cost-p_qty*p_price)>0.01 then
    return jsonb_build_object('ok',false,'error','invalid_fill_input');
  end if;
  if p_quote_at is null or p_quote_at>clock_timestamp() or p_quote_at<clock_timestamp()-interval '15 minutes' then
    return jsonb_build_object('ok',false,'error','invalid_quote_time');
  end if;
  select nav,cash_balance into v_nav,v_cash from public.paper_portfolio where market=p_market for update;
  if v_nav is null or v_nav<=0 or v_nav::text in ('NaN','Infinity','-Infinity') then
    return jsonb_build_object('ok',false,'error','invalid_nav');
  end if;
  if v_cash is null or v_cash<0 or v_cash::text in ('NaN','Infinity','-Infinity') then
    return jsonb_build_object('ok',false,'error','invalid_cash');
  end if;
  if p_cost<v_nav*0.005 then return jsonb_build_object('ok',false,'error','below_minimum_entry'); end if;
  if p_cost>v_cash then return jsonb_build_object('ok',false,'error','insufficient_cash'); end if;
  if (p_price-p_stop)/p_price>0.12 then return jsonb_build_object('ok',false,'error','stop_risk_exceeded'); end if;
  if exists(select 1 from public.paper_positions where market=p_market and symbol in ('SOXL','SOXS','TQQQ','SQQQ')
    and (qty is null or qty<=0 or current_price is null or current_price<=0 or qty::text in ('NaN','Infinity','-Infinity')
      or current_price::text in ('NaN','Infinity','-Infinity'))) then
    return jsonb_build_object('ok',false,'error','invalid_position_mark');
  end if;
  v_opposite := case p_symbol when 'SOXL' then 'SOXS' when 'SOXS' then 'SOXL' when 'TQQQ' then 'SQQQ' else 'TQQQ' end;
  if exists(select 1 from public.paper_positions where market=p_market and symbol=v_opposite and qty>0) then
    return jsonb_build_object('ok',false,'error','opposing_leveraged_exposure');
  end if;
  select coalesce(sum(qty*current_price),0) into v_used from public.paper_positions
    where market=p_market and symbol in ('SOXL','SOXS','TQQQ','SQQQ');
  if v_used+p_cost>v_nav*0.05 then return jsonb_build_object('ok',false,'error','no_sleeve_capacity'); end if;
  return jsonb_build_object('ok',true);
end $$;
revoke all on function public.leveraged_paper_admission_guard from public,anon,authenticated;
grant execute on function public.leveraged_paper_admission_guard to service_role;

-- Preserve the four existing, audited fill bodies and control gates. Refuse
-- unfamiliar source shape; never deploy a partial or silently unmatched rewrite.
do $migration$
declare v_name text; v_oid oid; v_def text; v_role text;
begin
  foreach v_name in array array['execute_soxl_paper_fill','execute_soxs_paper_fill','execute_tqqq_paper_fill','execute_sqqq_paper_fill'] loop
    if (select count(*) from pg_proc where pronamespace='public'::regnamespace and proname=v_name)<>1 then
      raise exception 'ambiguous fill signature: %',v_name;
    end if;
    select oid into v_oid from pg_proc where pronamespace='public'::regnamespace and proname=v_name;
    v_def:=pg_get_functiondef(v_oid);
    if position('leveraged_paper_admission_guard' in v_def)>0 then continue; end if;
    if (length(v_def)-length(replace(v_def,E'\ndeclare\n','')))/length(E'\ndeclare\n')<>1
      or (length(v_def)-length(replace(v_def,E'\nbegin\n','')))/length(E'\nbegin\n')<>1
      or (length(v_def)-length(replace(v_def,'  update public.paper_portfolio set','')))/length('  update public.paper_portfolio set')<>1
      or position('for update' in lower(v_def))=0 then raise exception 'unexpected fill source: %',v_name; end if;
    v_role:=replace(replace(v_name,'execute_',''),'_fill','');
    v_def:=replace(v_def,E'\ndeclare\n',E'\ndeclare\n  v_admission jsonb;\n');
    v_def:=replace(v_def,E'\nbegin\n',E'\nbegin\n  v_admission := public.leveraged_paper_admission_guard(p_symbol,p_market,p_currency,p_qty,p_fill_price,p_total_cost,p_price_retrieved_at,p_stop_loss,p_price_target);\n  if (v_admission->>''ok'')::boolean is distinct from true then return v_admission; end if;\n');
    v_def:=replace(v_def,'  update public.paper_portfolio set',
      format(E'  update public.paper_positions set entry_policy_version=p_policy_version where market=p_market and symbol=p_symbol and position_role=%L;\n\n  update public.paper_portfolio set',v_role));
    execute v_def;
  end loop;
end $migration$;

-- Subscription-only forecasts must expose the same new prompt identity as API/
-- hybrid forecasts. Old batches and synthetic legacy packets remain unchanged.
do $migration$
declare v_oid oid; v_def text; v_old text := '''subscription-v1'') returning id into r;';
begin
  select oid into v_oid from pg_proc where pronamespace='public'::regnamespace and proname='council_subscription_enqueue';
  if v_oid is null then raise exception 'subscription enqueue absent'; end if;
  v_def:=pg_get_functiondef(v_oid);
  if position('prediction_contract' in v_def)>0 then return; end if;
  if (length(v_def)-length(replace(v_def,v_old,'')))/length(v_old)<>1 then raise exception 'unexpected enqueue source'; end if;
  v_def:=replace(v_def,v_old, 'coalesce(p_snapshot#>>''{prediction_contract,version}'',''subscription-v1'')) returning id into r;');
  execute v_def;
end $migration$;
