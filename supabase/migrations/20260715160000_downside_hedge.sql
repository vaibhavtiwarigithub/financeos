-- Deterministic downside hedge control plane. US PAPER ONLY. SHIPS OFF.

create table if not exists public.downside_hedge_config (
  market text primary key check (market = 'us'),
  enabled boolean not null default false,
  paper_execute_enabled boolean not null default false,
  allowed_symbols jsonb not null default '["SH","PSQ"]'::jsonb
    check (jsonb_typeof(allowed_symbols) = 'array'),
  target_nav_pct numeric not null default 5 check (target_nav_pct between 1 and 8),
  max_nav_pct numeric not null default 8 check (max_nav_pct between 1 and 10),
  max_holding_days int not null default 5 check (max_holding_days between 1 and 10),
  cooldown_days int not null default 3 check (cooldown_days between 1 and 20),
  entry_confirmations int not null default 2 check (entry_confirmations between 1 and 5),
  exit_confirmations int not null default 2 check (exit_confirmations between 1 and 5),
  entry_danger_score int not null default 60 check (entry_danger_score between 40 and 90),
  exit_danger_score int not null default 45 check (exit_danger_score between 10 and 60),
  entry_return_20_pct numeric not null default -4 check (entry_return_20_pct between -20 and -1),
  entry_drawdown_20_pct numeric not null default -6 check (entry_drawdown_20_pct between -30 and -2),
  stop_loss_pct numeric not null default 5 check (stop_loss_pct between 2 and 10),
  updated_at timestamptz not null default now(),
  constraint downside_hedge_config_target_lte_max check (target_nav_pct <= max_nav_pct),
  constraint downside_hedge_config_hysteresis check (exit_danger_score < entry_danger_score),
  constraint downside_hedge_paper_requires_shadow check (not paper_execute_enabled or enabled)
);

create table if not exists public.downside_hedge_state (
  market text primary key references public.downside_hedge_config(market),
  state text not null default 'off' check (state in ('off','armed','active','exit_pending','cooldown')),
  entry_streak int not null default 0 check (entry_streak >= 0),
  exit_streak int not null default 0 check (exit_streak >= 0),
  active_symbol text,
  active_since timestamptz,
  cooldown_until timestamptz,
  last_evaluated_at timestamptz,
  last_observation_date date,
  last_reason text,
  updated_at timestamptz not null default now()
);

create table if not exists public.downside_hedge_events (
  id bigserial primary key,
  market text not null check (market = 'us'),
  event_type text not null check (event_type in ('evaluation','entry_filled','exit_requested','exit_completed','reconciled','error')),
  decision text not null check (decision in ('none','enter','exit')),
  state_before text,
  state_after text,
  symbol text,
  reason text not null,
  inputs jsonb not null default '{}'::jsonb,
  config_snapshot jsonb not null default '{}'::jsonb,
  parent_event_id bigint references public.downside_hedge_events(id),
  created_at timestamptz not null default now()
);

insert into public.downside_hedge_config (market) values ('us') on conflict (market) do nothing;
insert into public.downside_hedge_state (market) values ('us') on conflict (market) do nothing;

alter table public.paper_positions
  add column if not exists position_role text not null default 'alpha'
    check (position_role in ('alpha','hedge')),
  add column if not exists hedge_event_id bigint references public.downside_hedge_events(id);

alter table public.paper_trades
  add column if not exists position_role text not null default 'alpha'
    check (position_role in ('alpha','hedge')),
  add column if not exists hedge_event_id bigint references public.downside_hedge_events(id);

create unique index if not exists downside_hedge_one_open_position
  on public.paper_positions (market) where position_role = 'hedge';
create index if not exists downside_hedge_events_recent
  on public.downside_hedge_events (market, created_at desc);

create or replace function public.downside_hedge_events_immutable()
returns trigger language plpgsql set search_path = public as $$
begin
  raise exception 'downside_hedge_events is append-only';
end $$;

drop trigger if exists downside_hedge_events_no_mutation on public.downside_hedge_events;
create trigger downside_hedge_events_no_mutation
before update or delete on public.downside_hedge_events
for each row execute function public.downside_hedge_events_immutable();

create or replace function public.record_downside_hedge_evaluation(
  p_expected_updated_at timestamptz, p_observation_date date, p_decision text,
  p_state_before text, p_state_after text, p_entry_streak int, p_exit_streak int,
  p_symbol text, p_active_since timestamptz, p_cooldown_until timestamptz,
  p_reason text, p_inputs jsonb, p_config_snapshot jsonb
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_event_id bigint; v_updated text;
begin
  if p_decision not in ('none','enter','exit')
     or p_state_before not in ('off','armed','active','exit_pending','cooldown')
     or p_state_after not in ('off','armed','active','exit_pending','cooldown')
     or p_observation_date is null or coalesce(p_reason,'') = ''
     or (p_symbol is not null and upper(p_symbol) not in ('SH','PSQ')) then
    return jsonb_build_object('ok',false,'error','invalid_evaluation_shape');
  end if;
  update public.downside_hedge_state set
    state=p_state_after, entry_streak=greatest(0,p_entry_streak), exit_streak=greatest(0,p_exit_streak),
    active_symbol=case when p_symbol is null then null else upper(p_symbol) end,
    active_since=p_active_since, cooldown_until=p_cooldown_until,
    last_evaluated_at=now(), last_observation_date=p_observation_date,
    last_reason=p_reason, updated_at=now()
  where market='us' and updated_at is not distinct from p_expected_updated_at
    and (last_observation_date is null or last_observation_date < p_observation_date)
  returning market into v_updated;
  if v_updated is null then
    return jsonb_build_object('ok',false,'error','concurrent_or_duplicate_evaluation');
  end if;
  insert into public.downside_hedge_events (
    market,event_type,decision,state_before,state_after,symbol,reason,inputs,config_snapshot
  ) values (
    'us','evaluation',p_decision,p_state_before,p_state_after,
    case when p_symbol is null then null else upper(p_symbol) end,p_reason,
    coalesce(p_inputs,'{}'::jsonb),coalesce(p_config_snapshot,'{}'::jsonb)
  ) returning id into v_event_id;
  return jsonb_build_object('ok',true,'event_id',v_event_id);
end $$;

create or replace function public.execute_paper_hedge_fill(
  p_event_id bigint,
  p_signal_id uuid,
  p_symbol text,
  p_qty numeric,
  p_expected_price numeric,
  p_fill_price numeric,
  p_price_source text,
  p_price_retrieved_at timestamptz,
  p_bid numeric,
  p_ask numeric,
  p_spread numeric
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_cfg public.downside_hedge_config%rowtype;
  v_state public.downside_hedge_state%rowtype;
  v_cash numeric;
  v_positions_value numeric;
  v_nav numeric;
  v_total numeric;
  v_event public.downside_hedge_events%rowtype;
  v_signal record;
  v_result jsonb;
begin
  p_symbol := upper(trim(p_symbol));
  if p_symbol not in ('SH','PSQ') then
    return jsonb_build_object('ok', false, 'error', 'symbol_not_hard_allowlisted');
  end if;
  if p_qty is null or p_qty = 'NaN'::numeric or p_qty <= 0 or trunc(p_qty) <> p_qty
     or p_fill_price is null or p_fill_price = 'NaN'::numeric or p_fill_price <= 0
     or p_expected_price is null or p_expected_price = 'NaN'::numeric or p_expected_price <= 0 then
    return jsonb_build_object('ok', false, 'error', 'invalid_fill_shape');
  end if;

  select * into v_cfg from public.downside_hedge_config where market = 'us' for update;
  select * into v_state from public.downside_hedge_state where market = 'us' for update;
  if not coalesce(v_cfg.enabled, false) or not coalesce(v_cfg.paper_execute_enabled, false) then
    return jsonb_build_object('ok', false, 'error', 'hedge_execution_disabled');
  end if;
  if not (v_cfg.allowed_symbols ? p_symbol) then
    return jsonb_build_object('ok', false, 'error', 'symbol_not_config_allowlisted');
  end if;
  if v_state.state <> 'armed' or v_state.active_symbol is distinct from p_symbol then
    return jsonb_build_object('ok', false, 'error', 'state_not_armed');
  end if;

  select * into v_event from public.downside_hedge_events where id = p_event_id;
  if v_event.event_type <> 'evaluation' or v_event.decision <> 'enter'
     or v_event.market <> 'us' or v_event.symbol is distinct from p_symbol
     or v_event.created_at < now() - interval '1 day'
     or coalesce((v_event.inputs->>'dataFresh')::boolean, false) is not true then
    return jsonb_build_object('ok', false, 'error', 'invalid_entry_event');
  end if;
  if exists (select 1 from public.downside_hedge_events where parent_event_id = p_event_id and event_type = 'entry_filled') then
    return jsonb_build_object('ok', false, 'error', 'event_already_executed');
  end if;

  select id, status, agent_type, score_source, direction into v_signal
  from public.agent_signals where id = p_signal_id for update;
  if v_signal.id is null or v_signal.status <> 'claiming'
     or v_signal.agent_type <> 'downside_hedge'
     or v_signal.score_source <> 'hedge_control_v1'
     or v_signal.direction <> 'long' then
    return jsonb_build_object('ok', false, 'error', 'invalid_hedge_control_signal');
  end if;
  if exists (select 1 from public.paper_positions where market = 'us' and position_role = 'hedge') then
    return jsonb_build_object('ok', false, 'error', 'hedge_position_exists');
  end if;
  if exists (select 1 from public.paper_positions where market = 'us' and symbol = p_symbol) then
    return jsonb_build_object('ok', false, 'error', 'symbol_position_exists');
  end if;

  select cash_balance into v_cash from public.paper_portfolio where market = 'us' for update;
  if v_cash is null then return jsonb_build_object('ok', false, 'error', 'pool_not_found'); end if;
  select coalesce(sum(qty * coalesce(current_price, avg_cost)), 0)
    into v_positions_value from public.paper_positions where market = 'us';
  v_nav := v_cash + v_positions_value;
  v_total := p_qty * p_fill_price;
  if v_total > v_cash then return jsonb_build_object('ok', false, 'error', 'insufficient_cash'); end if;
  if v_nav <= 0 or v_total > v_nav * v_cfg.target_nav_pct / 100
     or v_total > v_nav * v_cfg.max_nav_pct / 100 then
    return jsonb_build_object('ok', false, 'error', 'hedge_nav_cap');
  end if;

  v_result := public.execute_paper_fill(
    p_signal_id, 'us', 'USD', p_symbol, p_qty, p_fill_price, v_total,
    p_price_source, p_price_retrieved_at, p_bid, p_ask, p_spread,
    0, 'downside_hedge_v1', 'Deterministic downside hedge',
    'Deterministic macro + market hedge control; excluded from learning',
    null, p_fill_price * (1 - v_cfg.stop_loss_pct / 100), 'HEDGE', p_expected_price
  );
  if coalesce((v_result->>'ok')::boolean, false) is not true then return v_result; end if;

  update public.paper_positions set position_role = 'hedge', hedge_event_id = p_event_id,
    resolved_horizon_days = v_cfg.max_holding_days
  where market = 'us' and symbol = p_symbol;
  update public.paper_trades set position_role = 'hedge', hedge_event_id = p_event_id,
    excluded_from_learning = true, tainted = true,
    taint_reason = 'downside hedge control trade; not an alpha observation'
  where signal_id = p_signal_id;
  update public.downside_hedge_state set state = 'active', active_symbol = p_symbol,
    active_since = now(), exit_streak = 0, last_reason = 'paper hedge filled', updated_at = now()
  where market = 'us';
  insert into public.downside_hedge_events (
    market,event_type,decision,state_before,state_after,symbol,reason,inputs,config_snapshot,parent_event_id
  ) values (
    'us','entry_filled','enter','armed','active',p_symbol,'paper hedge filled',
    jsonb_build_object('qty',p_qty,'fill_price',p_fill_price,'total',v_total,'nav',v_nav),
    to_jsonb(v_cfg),p_event_id
  );
  return v_result || jsonb_build_object('hedge', true, 'nav', v_nav, 'total', v_total);
end $$;

create or replace function public.request_paper_hedge_exit(p_event_id bigint, p_symbol text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_cfg public.downside_hedge_config%rowtype; v_event public.downside_hedge_events%rowtype; v_position uuid;
begin
  p_symbol := upper(trim(p_symbol));
  select * into v_cfg from public.downside_hedge_config where market='us' for update;
  if not coalesce(v_cfg.enabled,false) or not coalesce(v_cfg.paper_execute_enabled,false) then
    return jsonb_build_object('ok',false,'error','hedge_execution_disabled');
  end if;
  select * into v_event from public.downside_hedge_events where id=p_event_id;
  if v_event.event_type <> 'evaluation' or v_event.decision <> 'exit' or v_event.symbol is distinct from p_symbol then
    return jsonb_build_object('ok',false,'error','invalid_exit_event');
  end if;
  select id into v_position from public.paper_positions
    where market='us' and symbol=p_symbol and position_role='hedge' for update;
  if v_position is null then return jsonb_build_object('ok',false,'error','hedge_position_missing'); end if;
  update public.paper_positions set exit_reason='hedge_exit', updated_at=now() where id=v_position;
  update public.downside_hedge_state set state='exit_pending', exit_streak=v_cfg.exit_confirmations,
    last_reason='paper hedge exit requested', updated_at=now() where market='us';
  insert into public.downside_hedge_events (
    market,event_type,decision,state_before,state_after,symbol,reason,parent_event_id,config_snapshot
  ) values ('us','exit_requested','exit','active','exit_pending',p_symbol,'paper hedge exit requested',p_event_id,to_jsonb(v_cfg));
  return jsonb_build_object('ok',true,'position_id',v_position);
end $$;

create or replace function public.complete_paper_hedge_exit(p_symbol text, p_reason text)
returns void language plpgsql security definer set search_path = public as $$
declare v_days int; v_before text;
begin
  select cooldown_days into v_days from public.downside_hedge_config where market='us';
  select state into v_before from public.downside_hedge_state where market='us' for update;
  update public.downside_hedge_state set state='cooldown', entry_streak=0, exit_streak=0,
    active_symbol=null, active_since=null,
    cooldown_until=now()+make_interval(days=>coalesce(v_days,3)),
    last_reason=p_reason, updated_at=now() where market='us';
  insert into public.downside_hedge_events (
    market,event_type,decision,state_before,state_after,symbol,reason
  ) values ('us','exit_completed','exit',v_before,'cooldown',upper(trim(p_symbol)),coalesce(p_reason,'paper hedge closed'));
end $$;

do $$ declare t text;
begin
  foreach t in array array['downside_hedge_config','downside_hedge_state','downside_hedge_events'] loop
    execute format('alter table public.%I enable row level security',t);
    execute format('drop policy if exists %I_owner_read on public.%I',t,t);
    execute format('create policy %I_owner_read on public.%I for select to authenticated using (((select auth.jwt())->>''email'')=''vterminater@gmail.com'')',t,t);
    execute format('revoke all on table public.%I from anon',t);
    execute format('revoke insert,update,delete,truncate,references,trigger on table public.%I from authenticated',t);
    execute format('grant select on table public.%I to authenticated',t);
    execute format('grant all on table public.%I to service_role',t);
  end loop;
end $$;

revoke execute on function public.execute_paper_hedge_fill(bigint,uuid,text,numeric,numeric,numeric,text,timestamptz,numeric,numeric,numeric) from public,anon,authenticated;
revoke execute on function public.record_downside_hedge_evaluation(timestamptz,date,text,text,text,int,int,text,timestamptz,timestamptz,text,jsonb,jsonb) from public,anon,authenticated;
revoke execute on function public.request_paper_hedge_exit(bigint,text) from public,anon,authenticated;
revoke execute on function public.complete_paper_hedge_exit(text,text) from public,anon,authenticated;
grant execute on function public.execute_paper_hedge_fill(bigint,uuid,text,numeric,numeric,numeric,text,timestamptz,numeric,numeric,numeric) to service_role;
grant execute on function public.record_downside_hedge_evaluation(timestamptz,date,text,text,text,int,int,text,timestamptz,timestamptz,text,jsonb,jsonb) to service_role;
grant execute on function public.request_paper_hedge_exit(bigint,text) to service_role;
grant execute on function public.complete_paper_hedge_exit(text,text) to service_role;

do $$ begin
  begin perform cron.unschedule('kairos-downside-hedge-us'); exception when others then null; end;
end $$;
select cron.schedule('kairos-downside-hedge-us','10 21 * * 1-5',
  $$select public.kairos_call_agent('/api/agents/downside-hedge','{}'::jsonb,'POST',55000)$$);
