-- Manual Trade Guardian Stage 1: owner-armed software stops for manually
-- opened positions in the one permitted Robinhood account. A plan is mutable
-- current state; its event ledger is immutable evidence. Arming a plan never
-- submits an order.
begin;

create table public.guardian_protection_plans (
  id bigint generated always as identity primary key,
  ledger_entry_id bigint not null unique references public.agentic_position_ledger(id),
  account_id text not null check (account_id = '605420660'),
  market text not null default 'us' check (market = 'us'),
  symbol text not null,
  qty numeric not null check (qty > 0),
  entry_price numeric,
  stop_price numeric not null check (stop_price > 0),
  status text not null default 'pending_approval' check (status in (
    'pending_approval', 'armed', 'triggering', 'trigger_submitted',
    'trigger_needs_reconcile', 'declined', 'cancelled', 'invalidated'
  )),
  armed_at timestamptz,
  armed_by text,
  triggered_at timestamptz,
  trigger_proposal_id bigint references public.trade_proposals(id),
  terminal_reason text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index guardian_protection_plans_active_idx
  on public.guardian_protection_plans(account_id, status, symbol)
  where status in ('pending_approval', 'armed', 'triggering');

create table public.guardian_protection_events (
  id bigint generated always as identity primary key,
  plan_id bigint not null references public.guardian_protection_plans(id),
  event_type text not null check (event_type in (
    'created', 'armed', 'declined', 'trigger_claimed', 'trigger_submitted',
    'trigger_needs_reconcile', 'cancelled', 'invalidated'
  )),
  actor text not null check (actor in ('owner', 'system')),
  reason_code text,
  payload jsonb not null default '{}'::jsonb,
  occurred_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);
create index guardian_protection_events_plan_idx on public.guardian_protection_events(plan_id, occurred_at desc);

alter table public.guardian_protection_plans enable row level security;
alter table public.guardian_protection_events enable row level security;
revoke all on public.guardian_protection_plans, public.guardian_protection_events from public, anon, authenticated;
grant select on public.guardian_protection_plans, public.guardian_protection_events to authenticated;
grant select, insert, update on public.guardian_protection_plans to service_role;
grant select, insert on public.guardian_protection_events to service_role;

create policy guardian_protection_plans_owner_read on public.guardian_protection_plans
  for select to authenticated using (auth.jwt() ->> 'email' = 'vterminater@gmail.com');
create policy guardian_protection_events_owner_read on public.guardian_protection_events
  for select to authenticated using (auth.jwt() ->> 'email' = 'vterminater@gmail.com');

create or replace function public.guardian_protection_set_updated_at()
returns trigger language plpgsql set search_path = public as $$
begin new.updated_at = now(); return new; end $$;
create trigger guardian_protection_plans_set_updated_at
  before update on public.guardian_protection_plans
  for each row execute function public.guardian_protection_set_updated_at();

create or replace function public.reject_guardian_protection_event_mutation()
returns trigger language plpgsql set search_path = public as $$
begin raise exception 'guardian_protection_events is append-only'; end $$;
create trigger guardian_protection_events_no_update_delete
  before update or delete on public.guardian_protection_events
  for each row execute function public.reject_guardian_protection_event_mutation();
create trigger guardian_protection_events_no_truncate
  before truncate on public.guardian_protection_events
  for each statement execute function public.reject_guardian_protection_event_mutation();

-- Plan creation and its immutable evidence must succeed or fail together.
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
