-- Rollback-only integration proof. No inference, broker or order calls.
begin;
set local role service_role;
do $$
declare signal1 uuid; signal2 uuid; signal3 uuid; signal4 uuid; expiry date; today date;
  episode uuid; score integer; state_value text; original_expiry date; claimed integer; initial_count integer; i integer;
begin
  today := (now() at time zone 'America/New_York')::date;
  expiry := today+6;
  perform pg_advisory_xact_lock(hashtextextended('recent-candidates:us',0));
  select count(*) into initial_count from public.recent_qualified_candidates;
  if initial_count<>0 then raise exception 'Fixture expects an empty launch shortlist; refuse to touch real episodes'; end if;
  insert into public.agent_signals(symbol,market,direction,analyst_score,session_validated,score_source,is_holding,created_at)
    values('TEST-NO-REAL-ASSET','us','long',80,true,'deterministic_v1',false,now()-interval '4 seconds') returning id into signal1;
  perform public.record_recent_qualified_candidate(signal1,true,today,expiry,'screener_momentum');
  select id,expires_session into episode,original_expiry from public.recent_qualified_candidates where first_signal_id=signal1;
  if episode is null then raise exception 'Admission failed'; end if;
  insert into public.agent_signals(symbol,market,direction,analyst_score,session_validated,score_source,is_holding,created_at)
    values('TEST-NO-REAL-ASSET','us','long',70,true,'deterministic_v1',false,now()-interval '3 seconds') returning id into signal2;
  perform public.record_recent_qualified_candidate(signal2,true,today,today+8,'manual');
  select latest_score,expires_session into score,expiry from public.recent_qualified_candidates where id=episode;
  if score<>70 or expiry<>original_expiry then raise exception 'Refresh changed TTL or ignored a downgrade'; end if;
  perform public.record_recent_qualified_candidate(signal1,true,today,today+8,'manual');
  select latest_score into score from public.recent_qualified_candidates where id=episode;
  if score<>70 then raise exception 'Older assessment replaced newer evidence'; end if;
  update public.recent_qualified_candidates set latest_session=today-1 where id=episode;
  select count(*) into claimed from public.claim_recent_candidate_refresh('us',today,'{}');
  if claimed<>1 then raise exception 'Refresh claim failed'; end if;
  select count(*) into claimed from public.claim_recent_candidate_refresh('us',today,'{}');
  if claimed<>0 then raise exception 'Duplicate lease allowed'; end if;
  insert into public.agent_signals(symbol,market,direction,analyst_score,session_validated,score_source,is_holding,created_at)
    values('TEST-NO-REAL-ASSET','us','neutral',40,true,'deterministic_v1',false,now()-interval '2 seconds') returning id into signal3;
  perform public.record_recent_qualified_candidate(signal3,false,today,original_expiry,'manual');
  select state into state_value from public.recent_qualified_candidates where id=episode;
  if state_value<>'invalidated' then raise exception 'New assessment did not invalidate'; end if;
  insert into public.agent_signals(symbol,market,direction,analyst_score,session_validated,score_source,is_holding,created_at)
    values('TEST-NO-REAL-ASSET','us','long',85,true,'deterministic_v1',false,now()-interval '1 second') returning id into signal4;
  perform public.record_recent_qualified_candidate(signal4,true,today,original_expiry,'manual');
  if (select count(*) from public.recent_qualified_candidates)<>2 then raise exception 'Renewed episode erased history'; end if;
  update public.recent_qualified_candidates set state='expired' where first_signal_id=signal4;
  -- A later high alone must NOT restart an expired episode.
  update public.agent_signals set created_at=now() where id=signal2;
  perform public.record_recent_qualified_candidate(signal2,true,today,original_expiry,'manual');
  if exists(select 1 from public.recent_qualified_candidates where state='active') then raise exception 'Expired high restarted TTL'; end if;
  for i in 1..20 loop
    insert into public.agent_signals(symbol,market,direction,analyst_score,session_validated,score_source,is_holding)
      values('TEST-SHORTLIST-'||i,'us','long',60+i,true,'deterministic_v1',false) returning id into signal1;
    perform public.record_recent_qualified_candidate(signal1,true,today,original_expiry,'manual');
  end loop;
  insert into public.agent_signals(symbol,market,direction,analyst_score,session_validated,score_source,is_holding)
    values('TEST-SHORTLIST-BEST','us','long',99,true,'deterministic_v1',false) returning id into signal1;
  perform public.record_recent_qualified_candidate(signal1,true,today,original_expiry,'manual');
  if (select count(*) from public.recent_qualified_candidates where state='active' and market='us')<>20
    or not exists(select 1 from public.recent_qualified_candidates where symbol='TEST-SHORTLIST-BEST' and state='active')
    or not exists(select 1 from public.recent_qualified_candidates where symbol='TEST-SHORTLIST-1' and state='displaced') then
    raise exception 'Cap eviction or latest-score ranking failed';
  end if;
  insert into public.agent_signals(symbol,market,direction,analyst_score,session_validated,score_source,is_holding)
    values('TEST-SHORTLIST-NULL','us','long',100,true,'deterministic_v1',false) returning id into signal1;
  perform public.record_recent_qualified_candidate(signal1,null,today,original_expiry,'manual');
  if exists(select 1 from public.recent_qualified_candidates where symbol='TEST-SHORTLIST-NULL') then raise exception 'NULL eligibility admitted'; end if;
  insert into public.agent_signals(symbol,market,direction,analyst_score,session_validated,score_source,is_holding)
    values('TEST-SHORTLIST.NS','india','long',75,true,'deterministic_v1',false) returning id into signal1;
  today := (now() at time zone 'Asia/Kolkata')::date;
  perform public.record_recent_qualified_candidate(signal1,true,today,today+6,'india_screener');
  if (select count(*) from public.recent_qualified_candidates where state='active' and market='india')<>1 then raise exception 'India namespace mixed with US cap'; end if;
  if has_function_privilege('anon','public.record_recent_qualified_candidate(uuid,boolean,date,date,text)','execute')
    or has_function_privilege('authenticated','public.claim_recent_candidate_refresh(text,date,text[])','execute') then raise exception 'Public RPC privilege leak'; end if;
end $$;
select 'admission, downgrade, fixed TTL, stale-write rejection, shared lease, invalidation, renewal history, expiry non-renewal, 20-name cap, eviction, NULL eligibility, market separation and role guards passed' as verification;
rollback;
