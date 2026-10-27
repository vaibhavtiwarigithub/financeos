set local lock_timeout='5s';
set local statement_timeout='30s';
-- Owner approved 2026-10-27: observation-only, atomic paper exit-plan history.
-- No foreign key to the ephemeral position row: closing it must retain evidence.
lock table public.paper_positions in share row exclusive mode;
create table if not exists public.paper_position_plan_events (
  id bigint generated always as identity primary key,
  position_id uuid not null,
  market text not null check (market in ('us','india')),
  symbol text not null,
  position_role text,
  opened_at timestamptz,
  recorded_at timestamptz not null default clock_timestamp(),
  event_kind text not null check (event_kind in ('baseline','position_created','level_change','epoch_reset')),
  previous_stop_loss numeric,
  previous_target numeric,
  stop_loss numeric,
  price_target numeric
);
create index if not exists paper_position_plan_events_lookup_idx
  on public.paper_position_plan_events(market,position_id,recorded_at desc,id desc);
alter table public.paper_position_plan_events enable row level security;
revoke all on public.paper_position_plan_events from public,anon,authenticated,service_role;
grant select on public.paper_position_plan_events to service_role;
drop policy if exists paper_plan_events_service_read on public.paper_position_plan_events;
create policy paper_plan_events_service_read on public.paper_position_plan_events
  for select to service_role using (true);

create or replace function public.capture_paper_position_plan_event()
returns trigger language plpgsql security definer set search_path=pg_catalog,public as $$
declare kind text;
begin
  if new.market not in ('us','india') or new.market is null then return new; end if;
  if tg_op='INSERT' then kind:='position_created';
  elsif row(old.id,old.market,old.symbol,old.position_role,old.opened_at)
    is distinct from row(new.id,new.market,new.symbol,new.position_role,new.opened_at) then kind:='epoch_reset';
  elsif row(old.stop_loss,old.price_target) is distinct from row(new.stop_loss,new.price_target) then kind:='level_change';
  else return new;
  end if;
  insert into public.paper_position_plan_events
    (position_id,market,symbol,position_role,opened_at,event_kind,previous_stop_loss,previous_target,stop_loss,price_target)
  values (new.id,new.market,new.symbol,new.position_role,new.opened_at,kind,
    case when tg_op='UPDATE' then old.stop_loss else null end,
    case when tg_op='UPDATE' then old.price_target else null end,new.stop_loss,new.price_target);
  return new;
end $$;
revoke all on function public.capture_paper_position_plan_event() from public,anon,authenticated,service_role;

drop trigger if exists paper_position_plan_capture_insert on public.paper_positions;
create trigger paper_position_plan_capture_insert after insert on public.paper_positions
  for each row execute function public.capture_paper_position_plan_event();
drop trigger if exists paper_position_plan_capture_update on public.paper_positions;
create trigger paper_position_plan_capture_update
  after update of id,market,symbol,position_role,opened_at,stop_loss,price_target on public.paper_positions
  for each row when (row(old.id,old.market,old.symbol,old.position_role,old.opened_at,old.stop_loss,old.price_target)
    is distinct from row(new.id,new.market,new.symbol,new.position_role,new.opened_at,new.stop_loss,new.price_target))
  execute function public.capture_paper_position_plan_event();

create or replace function public.reject_paper_position_plan_mutation()
returns trigger language plpgsql set search_path=pg_catalog,public as $$
begin raise exception 'paper_position_plan_events is append-only'; end $$;
revoke all on function public.reject_paper_position_plan_mutation() from public,anon,authenticated,service_role;
drop trigger if exists paper_plan_events_no_mutation on public.paper_position_plan_events;
create trigger paper_plan_events_no_mutation before update or delete on public.paper_position_plan_events
  for each row execute function public.reject_paper_position_plan_mutation();
drop trigger if exists paper_plan_events_no_truncate on public.paper_position_plan_events;
create trigger paper_plan_events_no_truncate before truncate on public.paper_position_plan_events
  for each statement execute function public.reject_paper_position_plan_mutation();

-- This is a present baseline, never a reconstruction of earlier changes.
-- The lock serializes seed/capture with fills and monitors; reapply adds no seed.
insert into public.paper_position_plan_events
  (position_id,market,symbol,position_role,opened_at,event_kind,stop_loss,price_target)
select p.id,p.market,p.symbol,p.position_role,p.opened_at,'baseline',p.stop_loss,p.price_target
from public.paper_positions p where p.market in ('us','india') and not exists (
  select 1 from public.paper_position_plan_events e where e.position_id=p.id and e.market=p.market
    and e.symbol=p.symbol and e.position_role is not distinct from p.position_role
    and e.opened_at is not distinct from p.opened_at
);
comment on table public.paper_position_plan_events is
  'Atomic append-only paper stop/target observations. Baseline is current at recorded_at; earlier changes unknown. Trigger-only writes; owner/viewer reads through verified position-history API.';
