-- DISPOSABLE LOCAL DATABASE ONLY. Never run these financial fixtures in production.
\set ON_ERROR_STOP on
do $$declare n integer; before_count integer; begin
  if (select count(*) from public.paper_position_plan_events)<>1 then raise exception 'baseline count'; end if;
  if (select min(recorded_at) from public.paper_position_plan_events)<clock_timestamp()-interval '1 hour' then raise exception 'baseline was backdated'; end if;
  insert into public.paper_positions values ('00000000-0000-4000-8000-000000000002','india','TEST-NO-REAL-ASSET','alpha',now(),80,110,100);
  insert into public.paper_positions values ('00000000-0000-4000-8000-000000000003','us','TEST-LEVERAGED','soxl_paper',now(),90,120,100);
  insert into public.paper_positions values ('00000000-0000-4000-8000-000000000004','crypto','TEST-CRYPTO','alpha',now(),90,120,100);
  if (select count(*) from public.paper_position_plan_events)<>3 then raise exception 'market/role coverage'; end if;
  update public.paper_positions set current_price=105;
  update public.paper_positions set stop_loss=stop_loss,price_target=price_target;
  if (select count(*) from public.paper_position_plan_events)<>3 then raise exception 'unchanged/price-only duplicated'; end if;
  update public.paper_positions set stop_loss=95 where symbol='TEST-LEVERAGED';
  update public.paper_positions set price_target=null where symbol='TEST-LEVERAGED';
  if not exists(select 1 from public.paper_position_plan_events where symbol='TEST-LEVERAGED' and previous_target=120 and price_target is null and stop_loss=95) then raise exception 'target removal not captured'; end if;
  update public.paper_positions set opened_at=opened_at+interval '1 day' where symbol='TEST-LEVERAGED';
  if not exists(select 1 from public.paper_position_plan_events where symbol='TEST-LEVERAGED' and event_kind='epoch_reset') then raise exception 'epoch reset missing'; end if;
  select count(*) into before_count from public.paper_position_plan_events;
  begin
    update public.paper_positions set stop_loss=96 where symbol='TEST-LEVERAGED';
    raise exception using errcode='P0002',message='synthetic transaction rollback';
  exception when no_data_found then null; end;
  if (select count(*) from public.paper_position_plan_events)<>before_count or (select stop_loss from public.paper_positions where symbol='TEST-LEVERAGED')<>95 then raise exception 'audit did not rollback with position'; end if;
  alter table public.paper_position_plan_events add constraint test_audit_failure check(stop_loss<200);
  begin update public.paper_positions set stop_loss=999 where symbol='TEST-LEVERAGED';
    raise exception 'missing audit failure';
  exception when check_violation then null; end;
  if (select stop_loss from public.paper_positions where symbol='TEST-LEVERAGED')<>95 then raise exception 'position changed without audit'; end if;
  alter table public.paper_position_plan_events drop constraint test_audit_failure;
  begin update public.paper_position_plan_events set stop_loss=1;
    raise exception 'mutation guard failed';
  exception when raise_exception then if sqlerrm<>'paper_position_plan_events is append-only' then raise; end if; end;
  begin delete from public.paper_position_plan_events;
    raise exception 'delete guard failed';
  exception when raise_exception then if sqlerrm<>'paper_position_plan_events is append-only' then raise; end if; end;
  begin truncate public.paper_position_plan_events;
    raise exception 'truncate guard failed';
  exception when raise_exception then if sqlerrm<>'paper_position_plan_events is append-only' then raise; end if; end;
  delete from public.paper_positions where symbol='TEST-LEVERAGED';
  if (select count(*) from public.paper_position_plan_events)<>before_count then raise exception 'closed position lost history'; end if;
  if has_table_privilege('anon','public.paper_position_plan_events','SELECT') or has_table_privilege('authenticated','public.paper_position_plan_events','SELECT') or has_table_privilege('service_role','public.paper_position_plan_events','INSERT') or not has_table_privilege('service_role','public.paper_position_plan_events','SELECT') then raise exception 'ACL mismatch'; end if;
  if not (select relrowsecurity from pg_class where oid='public.paper_position_plan_events'::regclass) then raise exception 'RLS missing'; end if;
end $$;
select 'atomic capture, null removal, no-op suppression, all paper roles, rollback, write failure, immutable retention and ACL proof passed' as proof;
