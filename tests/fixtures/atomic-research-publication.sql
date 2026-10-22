-- Rollback-only proof. Synthetic names never become visible to other sessions.
-- No dependency on empty production tables; no real symbols or credentials.
begin;
set local role service_role;
do $$
declare a uuid; b uuid;
  s jsonb := '{"symbol":"TEST-WEEKLY-NO-REAL-ASSET","market":"us","direction":"long","analyst_score":99,"score_source":"deterministic_v1","status":"pending","session_validated":true,"signal_breakdown":{"trade_plan":{"status":"candidate"}}}'::jsonb;
begin
  if exists(select 1 from public.agent_signals where symbol='TEST-WEEKLY-NO-REAL-ASSET') then
    raise exception 'Synthetic name collision; refuse to overwrite existing evidence';
  end if;
  a:=public.publish_research_signal(s);
  b:=public.publish_research_signal(s||'{"analyst_score":40,"direction":"neutral"}'::jsonb);
  if (select status from public.agent_signals where id=a)<>'superseded'
    or (select analyst_score from public.agent_signals where id=b)<>40
    or (select count(*) from public.agent_signals where symbol='TEST-WEEKLY-NO-REAL-ASSET' and market='us' and status='pending')<>1
  then raise exception 'Publication recency/supersession proof failed'; end if;
  begin
    perform public.publish_research_signal(s,clock_timestamp()-interval '1 second');
    raise exception 'Expected deadline failure';
  exception when others then
    if sqlerrm not like '%publication deadline expired%' then raise; end if;
  end;
  if (select status from public.agent_signals where id=b)<>'pending' then
    raise exception 'Deadline retired existing signal';
  end if;
  begin
    perform public.publish_research_signal(s||jsonb_build_object('mandate_id',gen_random_uuid()));
    raise exception 'Expected foreign key failure';
  exception when foreign_key_violation then null;
  end;
  if (select status from public.agent_signals where id=b)<>'pending' then
    raise exception 'Failed insert did not roll back supersession';
  end if;
  perform public.publish_research_signal(s||'{"market":"india"}'::jsonb);
  if (select status from public.agent_signals where id=b)<>'pending' then raise exception 'Market isolation failed'; end if;
  perform public.publish_research_signal(s||'{"status":"weekend_staged","session_validated":false}'::jsonb);
  perform public.publish_research_signal(s);
  if exists(select 1 from public.agent_signals where symbol='TEST-WEEKLY-NO-REAL-ASSET' and market='us' and status='weekend_staged') then
    raise exception 'Stage revalidation failed';
  end if;
end $$;
rollback;
