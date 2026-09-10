-- Backfill the atomic plan-creation function into the already-linked project.
begin;
create or replace function public.create_guardian_protection_plan(
  p_ledger_entry_id bigint, p_account_id text, p_symbol text, p_qty numeric,
  p_entry_price numeric, p_stop_price numeric
) returns public.guardian_protection_plans
language plpgsql security definer set search_path = public as $$
declare p public.guardian_protection_plans;
begin
  if p_account_id <> '605420660' or p_qty <= 0 or p_stop_price <= 0 then
    raise exception 'invalid guardian protection plan';
  end if;
  insert into public.guardian_protection_plans
    (ledger_entry_id, account_id, market, symbol, qty, entry_price, stop_price)
  values (p_ledger_entry_id, p_account_id, 'us', upper(p_symbol), p_qty, p_entry_price, p_stop_price)
  returning * into p;
  insert into public.guardian_protection_events
    (plan_id, event_type, actor, reason_code, payload)
  values (p.id, 'created', 'system', 'manual_buy_detected',
    jsonb_build_object('ledger_entry_id', p.ledger_entry_id, 'symbol', p.symbol, 'stop_price', p.stop_price));
  return p;
end $$;
revoke all on function public.create_guardian_protection_plan(bigint,text,text,numeric,numeric,numeric) from public, anon, authenticated;
grant execute on function public.create_guardian_protection_plan(bigint,text,text,numeric,numeric,numeric) to service_role;
commit;
