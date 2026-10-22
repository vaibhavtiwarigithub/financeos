-- Version matches the verified target migration tracker after application.
begin;
-- Forward publication only: preserve all score/history rows and existing fills.
-- Serializing the supersede+insert prevents overlapping research producers
-- from publishing two pending assessments or retiring a signal without a successor.
create function public.publish_research_signal(p_signal jsonb, p_deadline timestamptz default null)
returns uuid language plpgsql security invoker set search_path=pg_catalog,public as $$
declare s public.agent_signals%rowtype;
begin
  s := jsonb_populate_record(null::public.agent_signals, p_signal);
  if s.market is null or s.market not in ('us','india') or s.symbol is null or btrim(s.symbol)=''
    or s.score_source is distinct from 'deterministic_v1'
    or s.session_validated is null or s.status is null or s.status not in ('pending','weekend_staged')
    or (s.status='pending' and s.session_validated is distinct from true)
    or (s.status='weekend_staged' and s.session_validated is distinct from false) then
    raise exception 'Invalid research publication contract';
  end if;
  s.symbol := upper(btrim(s.symbol));
  perform pg_advisory_xact_lock(hashtextextended('research-publish:'||s.market||':'||s.symbol,0));
  if p_deadline is not null and clock_timestamp() >= p_deadline then
    raise exception 'Research publication deadline expired';
  end if;
  s.id := gen_random_uuid();
  s.created_at := clock_timestamp();
  s.agent_label := coalesce(s.agent_label,'claude');
  s.is_holding := coalesce(s.is_holding,false);
  s.rank_rejected := coalesce(s.rank_rejected,false);
  update public.agent_signals set status='superseded'
    where market=s.market and symbol=s.symbol and status='pending';
  if s.session_validated then
    update public.agent_signals set status='revalidated'
      where market=s.market and symbol=s.symbol and status='weekend_staged';
  else
    update public.agent_signals set status='superseded'
      where market=s.market and symbol=s.symbol and status='weekend_staged';
  end if;
  insert into public.agent_signals select (s).*;
  return s.id;
end $$;
revoke all on function public.publish_research_signal(jsonb,timestamptz) from public,anon,authenticated;
grant execute on function public.publish_research_signal(jsonb,timestamptz) to service_role;
comment on function public.publish_research_signal(jsonb,timestamptz) is
  'Service-only atomic forward research publication; no score fitting, order or position mutation.';
commit;
