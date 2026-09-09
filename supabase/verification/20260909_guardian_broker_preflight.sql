select table_name, row_security_active(table_name::regclass) as rls
from (values ('public.agentic_position_ledger'),('public.agentic_position_scan_state'),('public.broker_instrument_preflights')) v(table_name);

select grantee, table_name, string_agg(privilege_type, ',' order by privilege_type) privileges
from information_schema.role_table_grants
where table_schema='public' and table_name in ('agentic_position_ledger','agentic_position_scan_state','broker_instrument_preflights')
group by grantee,table_name order by table_name,grantee;

begin;
insert into public.agentic_position_ledger(account_id,symbol,qty,source,delta_qty,transition_side)
values('605420660','ZZZGUARDVERIFY',1,'baseline',1,'baseline');
do $$ begin
  begin update public.agentic_position_ledger set qty=2 where symbol='ZZZGUARDVERIFY'; raise exception 'UPDATE guard failed';
  exception when others then if sqlerrm='UPDATE guard failed' then raise; end if; end;
  begin truncate public.agentic_position_ledger; raise exception 'TRUNCATE guard failed';
  exception when others then if sqlerrm='TRUNCATE guard failed' then raise; end if; end;
end $$;
insert into public.broker_instrument_preflights(
  broker,broker_account_id,broker_env,market,requested_symbol,side,order_type,allowed,checked_at,expires_at,source,raw_fingerprint
) values ('alpaca','verify','live','us','ZZZVERIFY','buy','market',false,now(),now()+interval '1 minute','verification','verify');
do $$ begin
  begin update public.broker_instrument_preflights set allowed=true where requested_symbol='ZZZVERIFY'; raise exception 'UPDATE guard failed';
  exception when others then if sqlerrm='UPDATE guard failed' then raise; end if; end;
  begin truncate public.broker_instrument_preflights; raise exception 'TRUNCATE guard failed';
  exception when others then if sqlerrm='TRUNCATE guard failed' then raise; end if; end;
end $$;
rollback;

select count(*) filter(where symbol='ZZZGUARDVERIFY') guardian_residue from public.agentic_position_ledger;
select count(*) filter(where requested_symbol='ZZZVERIFY') preflight_residue from public.broker_instrument_preflights;
