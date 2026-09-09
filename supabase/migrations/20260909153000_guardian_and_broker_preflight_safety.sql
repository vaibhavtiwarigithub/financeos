-- Reconcile out-of-band Manual Trade Guardian schema and add the broker
-- instrument-capability shadow ledger. No live order behavior is enabled here.
begin;

alter table public.learner_runs add column if not exists live_trades_closed integer;
alter table public.learner_runs add column if not exists live_win_rate numeric;

create table if not exists public.agentic_position_ledger (
  id bigint generated always as identity primary key,
  account_id text not null check (account_id='605420660'),
  symbol text not null,
  qty numeric not null,
  avg_cost numeric,
  source text not null,
  detected_at timestamptz not null default now(),
  matched_broker_order_id bigint references public.broker_orders(id),
  suggested_stop_price numeric,
  stop_proposal_id bigint references public.trade_proposals(id),
  created_at timestamptz not null default now()
);
alter table public.agentic_position_ledger enable row level security;
alter table public.agentic_position_ledger add column if not exists delta_qty numeric;
alter table public.agentic_position_ledger add column if not exists transition_side text;
alter table public.agentic_position_ledger add column if not exists matched_broker_order_ids jsonb not null default '[]'::jsonb;

do $$ declare c record;
begin
  for c in select conname from pg_constraint
    where conrelid='public.agentic_position_ledger'::regclass and contype='c'
      and pg_get_constraintdef(oid) ilike '%source%'
  loop execute format('alter table public.agentic_position_ledger drop constraint %I', c.conname); end loop;
end $$;
alter table public.agentic_position_ledger
  add constraint agentic_position_ledger_source_check check (source in ('baseline','manual','agentic','unknown'));
alter table public.agentic_position_ledger
  drop constraint if exists agentic_position_ledger_transition_side_check;
alter table public.agentic_position_ledger
  add constraint agentic_position_ledger_transition_side_check check (transition_side is null or transition_side in ('buy','sell','baseline'));

revoke all on public.agentic_position_ledger from anon, authenticated;
grant select on public.agentic_position_ledger to authenticated;
revoke update, delete, truncate on public.agentic_position_ledger from service_role;
grant select, insert on public.agentic_position_ledger to service_role;

create or replace function public.reject_agentic_position_ledger_truncate()
returns trigger language plpgsql set search_path=public as $$
begin raise exception 'agentic_position_ledger is append-only'; end $$;
drop trigger if exists agentic_position_ledger_no_update_delete on public.agentic_position_ledger;
create trigger agentic_position_ledger_no_update_delete before update or delete on public.agentic_position_ledger
for each row execute function public.reject_agentic_position_ledger_truncate();
drop trigger if exists agentic_position_ledger_no_truncate on public.agentic_position_ledger;
create trigger agentic_position_ledger_no_truncate before truncate on public.agentic_position_ledger
for each statement execute function public.reject_agentic_position_ledger_truncate();

create table if not exists public.agentic_position_scan_state (
  account_id text primary key check (account_id='605420660'),
  bootstrapped_at timestamptz,
  last_started_at timestamptz,
  last_completed_at timestamptz,
  lease_expires_at timestamptz
);
alter table public.agentic_position_scan_state enable row level security;
revoke all on public.agentic_position_scan_state from public, anon, authenticated;
grant select, insert, update on public.agentic_position_scan_state to service_role;

create or replace function public.claim_agentic_position_scan(p_account_id text, p_lease_seconds integer default 180)
returns table(acquired boolean, is_bootstrap boolean)
language plpgsql security definer set search_path=public as $$
declare s public.agentic_position_scan_state%rowtype;
begin
  if p_account_id <> '605420660' or p_lease_seconds < 30 or p_lease_seconds > 900 then
    raise exception 'invalid guardian scan claim';
  end if;
  insert into public.agentic_position_scan_state(account_id) values(p_account_id) on conflict do nothing;
  select * into s from public.agentic_position_scan_state where account_id=p_account_id for update;
  if s.lease_expires_at is not null and s.lease_expires_at > now() then
    return query select false, s.bootstrapped_at is null; return;
  end if;
  update public.agentic_position_scan_state set last_started_at=now(), lease_expires_at=now()+make_interval(secs=>p_lease_seconds)
    where account_id=p_account_id;
  return query select true, s.bootstrapped_at is null;
end $$;

create or replace function public.complete_agentic_position_scan(p_account_id text)
returns void language plpgsql security definer set search_path=public as $$
begin
  update public.agentic_position_scan_state
    set bootstrapped_at=coalesce(bootstrapped_at,now()), last_completed_at=now(), lease_expires_at=null
    where account_id=p_account_id;
end $$;
revoke all on function public.claim_agentic_position_scan(text,integer) from public,anon,authenticated;
revoke all on function public.complete_agentic_position_scan(text) from public,anon,authenticated;
grant execute on function public.claim_agentic_position_scan(text,integer) to service_role;
grant execute on function public.complete_agentic_position_scan(text) to service_role;

alter table public.broker_orders add column if not exists broker_account_id text;

create table if not exists public.broker_instrument_preflights (
  id bigint generated always as identity primary key,
  proposal_id bigint references public.trade_proposals(id),
  broker_order_id bigint references public.broker_orders(id),
  broker text not null,
  broker_account_id text not null,
  broker_env text not null check (broker_env in ('paper','live')),
  market text not null check (market in ('us','india')),
  requested_symbol text not null,
  canonical_symbol text,
  instrument_id text,
  side text not null check (side in ('buy','sell')),
  order_type text not null,
  allowed boolean not null,
  active boolean not null default false,
  buy_allowed boolean not null default false,
  sell_allowed boolean not null default false,
  close_only boolean not null default false,
  fractional_allowed boolean not null default false,
  lot_size numeric,
  tick_size numeric,
  checked_at timestamptz not null,
  expires_at timestamptz not null,
  source text not null,
  reason_code text,
  raw_fingerprint text not null,
  enforcement_mode text not null default 'shadow' check (enforcement_mode in ('shadow','enforced')),
  created_at timestamptz not null default now()
);
create index if not exists broker_instrument_preflights_proposal_idx on public.broker_instrument_preflights(proposal_id,created_at desc);
alter table public.broker_instrument_preflights enable row level security;
revoke all on public.broker_instrument_preflights from public,anon,authenticated;
grant select on public.broker_instrument_preflights to authenticated;
revoke all on public.broker_instrument_preflights from service_role;
grant select,insert on public.broker_instrument_preflights to service_role;

create or replace function public.reject_broker_preflight_mutation()
returns trigger language plpgsql set search_path=public as $$
begin raise exception 'broker_instrument_preflights is append-only'; end $$;
drop trigger if exists broker_preflights_no_update_delete on public.broker_instrument_preflights;
create trigger broker_preflights_no_update_delete before update or delete on public.broker_instrument_preflights
for each row execute function public.reject_broker_preflight_mutation();
drop trigger if exists broker_preflights_no_truncate on public.broker_instrument_preflights;
create trigger broker_preflights_no_truncate before truncate on public.broker_instrument_preflights
for each statement execute function public.reject_broker_preflight_mutation();

commit;
