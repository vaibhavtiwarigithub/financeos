-- Preserve the existing equity RPC body and all its controls. Refuse drift.
do $migration$
declare
  fn regprocedure;
  body text;
  old_market text := 'p_market not in (''us'', ''india'')';
  old_mandate text := 'select score_threshold, max_open_positions
    into v_mandate_threshold, v_mandate_max_names
    from public.trading_mandates where market = p_market;';
  new_mandate text := 'if p_market = ''crypto'' then
    if p_symbol not in (''BTC-USD'', ''ETH-USD'', ''SOL-USD'')
       or p_currency is distinct from ''USD''
       or p_mandate_version is distinct from 1
       or p_stop_loss is null or p_stop_loss <= 0 or p_stop_loss >= p_fill_price
       or p_price_target is null or p_price_target <= p_fill_price
       or abs(p_qty * p_fill_price - p_total_cost) > 0.0001
       or not exists (
         select 1 from public.agent_signals s where s.id = p_signal_id
           and s.symbol = p_symbol and s.asset_class = ''crypto''
           and s.score_source = ''crypto_native_shadow_v1''
           and s.status = ''claiming'' and s.session_validated = true
           and s.direction = ''long'' and s.analyst_score >= 60
           and s.analyst_score = p_analyst_score
           and s.created_at >= now() - interval ''48 hours''
       ) then
      return jsonb_build_object(''ok'', false, ''error'', ''invalid_crypto_signal_or_geometry'');
    end if;
    if exists (select 1 from public.paper_positions where market = ''crypto'' and symbol = p_symbol) then
      return jsonb_build_object(''ok'', false, ''error'', ''open_position_exists'');
    end if;
    v_mandate_threshold := 60;
    v_mandate_max_names := 3;
  else
    select score_threshold, max_open_positions
      into v_mandate_threshold, v_mandate_max_names
      from public.trading_mandates where market = p_market;
  end if;';
begin
  select oid::regprocedure into strict fn from pg_proc
    where pronamespace = 'public'::regnamespace and proname = 'execute_paper_fill';
  body := pg_get_functiondef(fn);
  if strpos(body, 'invalid_crypto_signal_or_geometry') > 0 then return; end if;
  if (length(body)-length(replace(body, old_market, '')))/length(old_market) <> 1
     or (length(body)-length(replace(body, old_mandate, '')))/length(old_mandate) <> 1 then
    raise exception 'execute_paper_fill contract drift; refusing patch';
  end if;
  body := replace(body, old_market, 'p_market not in (''us'', ''india'', ''crypto'')');
  body := replace(body, old_mandate, new_mandate);
  execute body;
end
$migration$;
