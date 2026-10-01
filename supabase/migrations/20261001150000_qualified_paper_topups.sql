-- Qualified paper-only add-to-winner support.
--
-- `execute_paper_fill` already performs the market/pool lock, paper-mode and
-- mandate checks, cash/daily/per-order caps, existing-position lock, and refuses
-- an add unless the new fill is above weighted cost. The generic table trigger
-- intentionally blocks direct alpha BUY inserts while a position is open. This
-- narrowly authorizes that trigger bypass only through a dedicated wrapper
-- around the validated RPC's own lot insert; every other RPC caller retains
-- the existing anti-pyramid behavior. Partial-exit residual lots keep their
-- existing independent path.
-- Live execution and all portfolio/risk limits are unchanged.

create or replace function public.prevent_paper_alpha_pyramid()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if new.order_side = 'buy'
     and coalesce(new.position_role, 'alpha') = 'alpha'
     and not coalesce(new.partial_exit_lot, false)
     and exists (
       select 1
       from public.paper_positions position
       where position.market = new.market
         and upper(position.symbol) = upper(new.symbol)
         and coalesce(position.position_role, 'alpha') = 'alpha'
     )
     and not (
       coalesce(current_setting('kairos.paper_topup_authorized', true), 'off') = 'on'
       and exists (
         select 1
         from public.paper_positions position
         where position.market = new.market
           and upper(position.symbol) = upper(new.symbol)
           and coalesce(position.position_role, 'alpha') = 'alpha'
           and new.fill_price > position.avg_cost
       )
     ) then
    raise exception using
      errcode = 'P0001',
      message = 'existing_open_position';
  end if;
  return new;
end;
$$;

revoke all on function public.prevent_paper_alpha_pyramid() from public;

-- Patch the deployed, safety-critical RPC only at exact guarded fragments. Do
-- not replace its full body from an older migration: that would erase later
-- risk, freshness, attribution, or control checks.
do $$
declare
  v_signature regprocedure :=
    'public.execute_paper_fill(uuid,text,text,text,numeric,numeric,numeric,text,timestamptz,numeric,numeric,numeric,numeric,text,text,text,numeric,numeric,text,numeric,uuid,integer,jsonb,integer,integer,integer,numeric,numeric,timestamptz)'::regprocedure;
  v_definition text;
  v_patched text;
  v_existing_gate text := E'  elsif p_fill_price <= v_existing_avg then\n    return jsonb_build_object(''ok'', false, ''error'', ''pyramid_gate'');\n  end if;';
  v_existing_gate_replacement text := E'  elsif p_day_start is null then\n    return jsonb_build_object(''ok'', false, ''error'', ''top_up_session_window_missing'');\n  elsif exists (\n    select 1 from public.paper_trades\n    where market = p_market and upper(symbol) = upper(p_symbol)\n      and order_side = ''buy'' and executed_at >= p_day_start\n      and not coalesce(partial_exit_lot, false)\n  ) then\n    return jsonb_build_object(''ok'', false, ''error'', ''top_up_already_filled_this_session'');\n  elsif p_fill_price <= v_existing_avg then\n    return jsonb_build_object(''ok'', false, ''error'', ''pyramid_gate'');\n  end if;';
begin
  v_definition := pg_get_functiondef(v_signature);

  if length(v_definition) - length(replace(v_definition, v_existing_gate, '')) <> length(v_existing_gate) then
    raise exception 'execute_paper_fill contract drift or already patched; refusing qualified top-up patch';
  end if;
  if position('p_fill_price <= v_existing_avg' in v_definition) = 0
     or position('v_existing_id is not null' in v_definition) = 0
     or position('update public.paper_positions set' in v_definition) = 0 then
    raise exception 'execute_paper_fill lacks expected profitable top-up and atomic position-update gates';
  end if;

  v_patched := replace(v_definition, v_existing_gate, v_existing_gate_replacement);

  if v_patched = v_definition
     or position('top_up_already_filled_this_session' in v_patched) = 0
     or position('top_up_session_window_missing' in v_patched) = 0 then
    raise exception 'execute_paper_fill one-top-up-per-session patch did not produce expected source';
  end if;

  execute v_patched;
end;
$$;

-- This is the only RPC that sets the trigger's transaction-local authorization.
-- It pre-validates the existing profitable position, then delegates all actual
-- fill, mandate, quote-signal, market-control, cash, and risk checks to the
-- unchanged execute_paper_fill body. That RPC re-locks/rechecks the position
-- and performs the same-session duplicate check under the market-pool lock.
create or replace function public.execute_paper_topup(
  p_signal_id uuid,
  p_market text,
  p_currency text,
  p_symbol text,
  p_qty numeric,
  p_fill_price numeric,
  p_total_cost numeric,
  p_price_source text,
  p_price_retrieved_at timestamptz,
  p_bid numeric,
  p_ask numeric,
  p_spread numeric,
  p_analyst_score numeric,
  p_strategy_id text,
  p_notes text,
  p_rationale text,
  p_price_target numeric,
  p_stop_loss numeric,
  p_sector text,
  p_expected_price numeric,
  p_mandate_id uuid,
  p_mandate_version integer,
  p_mandate_snapshot jsonb,
  p_resolved_horizon_days integer,
  p_max_open_names integer,
  p_max_sector_names integer,
  p_per_trade_cap numeric,
  p_daily_notional_cap numeric,
  p_day_start timestamptz
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_existing_avg numeric;
  v_result jsonb;
begin
  perform set_config('kairos.paper_topup_authorized', 'off', true);

  if p_market not in ('us', 'india') or p_day_start is null then
    return jsonb_build_object('ok', false, 'error', 'invalid_topup_scope_or_session');
  end if;

  select avg_cost into v_existing_avg
    from public.paper_positions
    where market = p_market and upper(symbol) = upper(p_symbol)
      and coalesce(position_role, 'alpha') = 'alpha';
  if not found then
    return jsonb_build_object('ok', false, 'error', 'open_position_not_found');
  end if;
  if v_existing_avg is null or p_fill_price is null or p_fill_price <= v_existing_avg then
    return jsonb_build_object('ok', false, 'error', 'pyramid_gate');
  end if;

  perform set_config('kairos.paper_topup_authorized', 'on', true);
  v_result := public.execute_paper_fill(
    p_signal_id, p_market, p_currency, p_symbol, p_qty, p_fill_price,
    p_total_cost, p_price_source, p_price_retrieved_at, p_bid, p_ask,
    p_spread, p_analyst_score, p_strategy_id, p_notes, p_rationale,
    p_price_target, p_stop_loss, p_sector, p_expected_price, p_mandate_id,
    p_mandate_version, p_mandate_snapshot, p_resolved_horizon_days,
    p_max_open_names, p_max_sector_names, p_per_trade_cap,
    p_daily_notional_cap, p_day_start
  );
  perform set_config('kairos.paper_topup_authorized', 'off', true);
  return v_result;
end;
$$;

revoke all on function public.execute_paper_topup(uuid,text,text,text,numeric,numeric,numeric,text,timestamptz,numeric,numeric,numeric,numeric,text,text,text,numeric,numeric,text,numeric,uuid,integer,jsonb,integer,integer,integer,numeric,numeric,timestamptz) from public, anon, authenticated;
grant execute on function public.execute_paper_topup(uuid,text,text,text,numeric,numeric,numeric,text,timestamptz,numeric,numeric,numeric,numeric,text,text,text,numeric,numeric,text,numeric,uuid,integer,jsonb,integer,integer,integer,numeric,numeric,timestamptz) to service_role;

notify pgrst, 'reload schema';

comment on function public.prevent_paper_alpha_pyramid() is
  'Rejects direct paper alpha BUY pyramids. Only the service-role execute_paper_topup wrapper can authorize a profitable, risk-capped top-up around the validated fill RPC lot insert.';
