-- DISPOSABLE LOCAL DATABASE ONLY. Never run these financial fixtures in production.
\set ON_ERROR_STOP on
grant select,insert,update on public.paper_positions to service_role;
set role service_role;
insert into public.paper_positions values ('00000000-0000-4000-8000-000000000005','us','TEST-SEQUENCE-ACL','alpha',now(),70,90,80);
update public.paper_positions set stop_loss=75 where symbol='TEST-SEQUENCE-ACL';
reset role;
do $$begin
  if (select count(*) from public.paper_position_plan_events where symbol='TEST-SEQUENCE-ACL')<>2 then raise exception 'trigger-only sequence capture failed'; end if;
  if has_sequence_privilege('anon','public.paper_position_plan_events_id_seq','USAGE') or has_sequence_privilege('authenticated','public.paper_position_plan_events_id_seq','USAGE') or has_sequence_privilege('service_role','public.paper_position_plan_events_id_seq','USAGE') then raise exception 'sequence ACL is broad'; end if;
end $$;
select 'service position write still captures atomically with no sequence/function execute grant' as proof;
