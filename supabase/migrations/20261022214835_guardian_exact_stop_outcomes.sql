-- Measurement only. Preserve every historical row and append-only trigger.
alter table public.live_recommendations
  add column if not exists market text not null default 'us' check (market in ('us','india')),
  add column if not exists guardian_contract jsonb;
alter table public.live_recommendation_marks add column if not exists guardian_outcomes jsonb;
create index if not exists live_recommendations_guardian_market_idx
  on public.live_recommendations (market, issued_at, id) where kind='guardian_stop';

-- A suggestion is frozen when it becomes observable, never backdated to an old fill.
create or replace function public.capture_guardian_stop_measurement()
returns trigger language plpgsql security invoker set search_path=public,pg_temp as $$
declare
  stamp timestamptz := clock_timestamp();
  m text; account text; sym text; quantity numeric; stop numeric; cost numeric;
  episode text; source_version text;
begin
  if tg_table_name='agentic_position_ledger' then
    if new.source is distinct from 'manual' or new.transition_side is distinct from 'buy' then return new; end if;
    if tg_op='UPDATE' then
      if new.suggested_stop_price is not distinct from old.suggested_stop_price then return new; end if;
    end if;
    m := 'us'; account := new.account_id; sym := new.symbol;
    quantity := coalesce(new.delta_qty,new.qty); stop := new.suggested_stop_price; cost := new.avg_cost;
    episode := 'ledger:'||new.id; source_version := 'manual_fill_suggestion';
  else
    if new.market is null or new.market not in ('us','india') then return new; end if;
    if tg_op='UPDATE' then
      if new.stop_price is not distinct from old.stop_price then return new; end if;
    end if;
    m := new.market; account := new.account_id; sym := new.symbol;
    quantity := new.qty; stop := new.stop_price; cost := new.entry_price;
    episode := case when new.ledger_entry_id is not null then 'ledger:'||new.ledger_entry_id else 'plan:'||new.id end;
    source_version := 'guardian_plan';
  end if;
  if stop is null or stop <= 0 or quantity is null or quantity <= 0 then return new; end if;
  if tg_table_name='guardian_protection_plans' and tg_op='INSERT' then
    if exists(select 1 from public.live_recommendations r
      where r.source_table='agentic_position_ledger' and r.source_id=new.ledger_entry_id::text
        and r.kind='guardian_stop' and r.guardian_contract is not null and r.level_price=stop) then
      return new; -- One advice record, not a duplicate when the matching plan is created.
    end if;
  end if;
  if m='india' then
    if upper(sym) like '%.BO' then return new; end if;
    if upper(sym) not like '%.NS' then sym := sym||'.NS'; end if;
  end if;
  insert into public.live_recommendations
    (dedup_key,kind,market,account_id,symbol,issued_at,reference_price,level_price,qty_suggested,
      horizon_sessions,source_table,source_id,rationale,guardian_contract)
  values ('gs:'||tg_table_name||':'||new.id||':'||stamp::text,'guardian_stop',m,account,upper(sym),stamp,cost,stop,quantity,
    20,tg_table_name,new.id::text,'Frozen app stop suggestion; measurement only, not an order.',
    jsonb_build_object('version','guardian_exact_stop_v1','reference_basis','next_session_open',
      'captured_at',stamp,'episode_key',episode,'source_version',source_version,
      'stop_formula_version','unrecorded','extra_sell_cost_bps',10));
  return new;
end $$;
revoke all on function public.capture_guardian_stop_measurement() from public,anon,authenticated;
grant execute on function public.capture_guardian_stop_measurement() to service_role;
create trigger capture_guardian_ledger_measurement after insert or update of suggested_stop_price
  on public.agentic_position_ledger for each row execute function public.capture_guardian_stop_measurement();
create trigger capture_guardian_plan_measurement after insert or update of stop_price
  on public.guardian_protection_plans for each row execute function public.capture_guardian_stop_measurement();

-- No historical backfill: mutable old stops have no trustworthy issue-time version.
-- The existing owner-only APIs and service-only, append-only evidence remain unchanged.
