-- Version aligned to the verified Supabase migration tracker after application.
begin;
create table public.recent_qualified_candidates (
  id uuid primary key default gen_random_uuid(),
  market text not null check (market in ('us','india')),
  symbol text not null,
  first_signal_id uuid not null references public.agent_signals(id),
  latest_signal_id uuid not null references public.agent_signals(id),
  first_score integer not null check (first_score between 0 and 100),
  latest_score integer not null check (latest_score between 0 and 100),
  first_session date not null,
  latest_session date not null,
  expires_session date not null check (expires_session >= first_session),
  latest_at timestamptz not null,
  discovery_source text,
  state text not null check (state in ('active','invalidated','expired','displaced')),
  refresh_lease_until timestamptz,
  refresh_session date,
  refresh_attempts integer not null default 0,
  unique (first_signal_id)
);
create unique index recent_candidates_one_active on public.recent_qualified_candidates(market,symbol) where state='active';
create index recent_candidates_latest_signal on public.recent_qualified_candidates(latest_signal_id);
create index recent_candidates_market_symbol on public.recent_qualified_candidates(market,symbol,latest_at desc);
alter table public.recent_qualified_candidates enable row level security;
create policy recent_candidates_owner_read on public.recent_qualified_candidates for select to authenticated
  using (((select auth.jwt()) ->> 'email') = 'vterminater@gmail.com');
revoke all on public.recent_qualified_candidates from public, anon, authenticated;
grant select on public.recent_qualified_candidates to authenticated;
grant select,insert,update on public.recent_qualified_candidates to service_role;

-- Caller supplies the existing research entry predicate and the verified exchange
-- calendar expiry. This is NOT order eligibility. Only trusted server code calls it.
create function public.record_recent_qualified_candidate(
  p_signal_id uuid, p_eligible boolean, p_session date, p_expiry date, p_source text
) returns void language plpgsql security invoker set search_path=pg_catalog,public as $$
declare s public.agent_signals%rowtype; previous public.recent_qualified_candidates%rowtype;
  weakest public.recent_qualified_candidates%rowtype; today date;
begin
  select * into strict s from public.agent_signals where id=p_signal_id;
  if s.market not in ('us','india') or s.market is null then return; end if;
  today := (now() at time zone case when s.market='india' then 'Asia/Kolkata' else 'America/New_York' end)::date;
  if p_session <> today or p_expiry < p_session or p_expiry > p_session+14 then raise exception 'Invalid shortlist session window'; end if;
  if s.session_validated is distinct from true or s.score_source is distinct from 'deterministic_v1'
    or (s.created_at at time zone case when s.market='india' then 'Asia/Kolkata' else 'America/New_York' end)::date <> p_session
    or s.symbol in ('SOXL','SOXS','TQQQ','SQQQ') or s.asset_class='crypto' or s.symbol like '%-USD' then return; end if;
  perform pg_advisory_xact_lock(hashtextextended('recent-candidates:'||s.market,0));
  update public.recent_qualified_candidates set state='expired',refresh_lease_until=null
    where market=s.market and state='active' and expires_session < p_session;
  select * into previous from public.recent_qualified_candidates
    where market=s.market and symbol=s.symbol order by latest_at desc,id desc limit 1;
  -- An out-of-order concurrent assessment may never overwrite newer evidence.
  if previous.id is not null and (s.created_at < previous.latest_at or previous.latest_signal_id=s.id) then return; end if;
  if previous.id is not null and previous.state='active' then
    update public.recent_qualified_candidates set latest_signal_id=s.id,latest_score=s.analyst_score,
      latest_session=p_session,latest_at=s.created_at,refresh_lease_until=null,
      state=case when p_eligible and s.direction='long' and not coalesce(s.is_holding,false) then 'active' else 'invalidated' end
      where id=previous.id;
    return;
  end if;
  if p_eligible is distinct from true or s.direction is distinct from 'long' or coalesce(s.is_holding,false) then
    -- A disqualifying observation permits a later, genuinely new episode.
    if previous.id is not null then
      update public.recent_qualified_candidates set state='invalidated', latest_signal_id=s.id,
        latest_score=s.analyst_score,latest_session=p_session,latest_at=s.created_at,refresh_lease_until=null where id=previous.id;
    end if;
    return;
  end if;
  -- Expiry/cap eviction is NOT a new thesis. Routine high scores cannot renew TTL.
  if previous.id is not null and previous.state <> 'invalidated' then return; end if;
  if (select count(*) from public.recent_qualified_candidates where market=s.market and state='active') >= 20 then
    select * into weakest from public.recent_qualified_candidates where market=s.market and state='active'
      order by latest_score asc,first_session asc,symbol desc limit 1;
    if s.analyst_score <= weakest.latest_score then return; end if;
    update public.recent_qualified_candidates set state='displaced',refresh_lease_until=null where id=weakest.id;
  end if;
  insert into public.recent_qualified_candidates(market,symbol,first_signal_id,latest_signal_id,first_score,latest_score,
    first_session,latest_session,expires_session,latest_at,discovery_source,state)
    values(s.market,s.symbol,s.id,s.id,s.analyst_score,s.analyst_score,p_session,p_session,p_expiry,s.created_at,p_source,'active');
end; $$;
revoke all on function public.record_recent_qualified_candidate(uuid,boolean,date,date,text) from public,anon,authenticated;
grant execute on function public.record_recent_qualified_candidate(uuid,boolean,date,date,text) to service_role;

-- At most five stale names, two attempts/name/session, shared by paper and live.
-- Market lock also serializes claims against recording/eviction.
create function public.claim_recent_candidate_refresh(p_market text,p_session date,p_excluded text[] default '{}')
returns setof public.recent_qualified_candidates language plpgsql security invoker set search_path=pg_catalog,public as $$
declare today date;
begin
  if p_market not in ('us','india') or p_market is null then raise exception 'Invalid market'; end if;
  today := (now() at time zone case when p_market='india' then 'Asia/Kolkata' else 'America/New_York' end)::date;
  if p_session <> today then raise exception 'Refresh must use current market session'; end if;
  perform pg_advisory_xact_lock(hashtextextended('recent-candidates:'||p_market,0));
  return query with chosen as (
    select id from public.recent_qualified_candidates where market=p_market and state='active'
      and expires_session>=p_session and latest_session<p_session
      and not (symbol=any(coalesce(p_excluded,'{}'::text[])))
      and (refresh_lease_until is null or refresh_lease_until<now())
      and (refresh_session is distinct from p_session or refresh_attempts<2)
    order by latest_session asc,latest_score desc,symbol asc limit 5 for update
  ) update public.recent_qualified_candidates r set refresh_lease_until=now()+interval '6 minutes',
    refresh_attempts=case when refresh_session=p_session then refresh_attempts+1 else 1 end,refresh_session=p_session
    from chosen where r.id=chosen.id returning r.*;
end; $$;
revoke all on function public.claim_recent_candidate_refresh(text,date,text[]) from public,anon,authenticated;
grant execute on function public.claim_recent_candidate_refresh(text,date,text[]) to service_role;
comment on table public.recent_qualified_candidates is 'Bounded research reconsideration episodes, not order eligibility; original expiry never rolls forward.';
commit;
