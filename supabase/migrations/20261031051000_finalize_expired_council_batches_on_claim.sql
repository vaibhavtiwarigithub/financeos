-- Finalize stale subscription work when the existing worker naturally polls.
-- Expired jobs are terminalized by the established advancer; this never retries
-- inference or fabricates a member forecast. Bounded cleanup avoids a long
-- claim transaction when a backlog contains many expired batches.
create or replace function public.council_subscription_claim(p_token_hash text) returns jsonb
language plpgsql security invoker set search_path = '' as $$
declare
  w public.llm_council_workers;
  j public.llm_council_jobs;
  b public.llm_council_batches;
  expired_batch public.llm_council_batches;
  peers jsonb;
begin
  select * into w from public.llm_council_workers where token_sha256=p_token_hash and revoked_at is null for update;
  if not found then raise exception 'unauthorized_worker'; end if;
  update public.llm_council_workers set last_seen_at=now() where id=w.id;

  -- A worker may finish newer batches while older ones have passed their
  -- deadline. The normal 12-hour batch advancer is invoked on submissions,
  -- so these abandoned batches otherwise remain "running" forever. Advance at
  -- most 10 oldest expired batches for this worker per natural claim poll.
  for expired_batch in
    select y.*
      from public.llm_council_batches y
     where y.status='running' and y.deadline<=now()
       and exists(select 1 from public.llm_council_jobs x where x.batch_id=y.id and x.worker_id=w.id)
     order by y.deadline,y.id
     limit 10
     for update of y skip locked
  loop
    perform public.council_subscription_advance(expired_batch.id);
  end loop;

  if (select count(*) from public.llm_council_jobs x join public.llm_council_batches y on y.id=x.batch_id where x.worker_id=w.id and x.status='leased' and x.lease_until>now() and y.status='running' and y.deadline>now()) >= 3 then return null; end if;
  select x.* into j from public.llm_council_jobs x join public.llm_council_batches y on y.id=x.batch_id
   where x.worker_id=w.id and y.status='running' and y.deadline>now()
    and (y.synthetic or exists(select 1 from public.llm_council_config where id='global' and enabled and execution_mode=y.execution_mode and execution_mode in ('subscription','hybrid') and w.id=any(subscription_worker_ids)))
    and (x.status='queued' or (x.status='leased' and x.lease_until<=now() and x.attempts<2))
   order by x.created_at,x.id limit 1 for update of x skip locked;
  if not found then return null; end if;
  select * into b from public.llm_council_batches where id=j.batch_id;
  if j.status<>'leased' or j.lease_until<=now() then update public.llm_council_jobs set status='leased',lease_id=gen_random_uuid(),lease_until=least(b.deadline,now()+interval '10 minutes'),attempts=attempts+1 where id=j.id returning * into j; end if;
  select coalesce(jsonb_agg(jsonb_build_object('forecast',result) order by worker_id),'[]'::jsonb) into peers from public.llm_council_jobs where batch_id=b.id and round=j.round-1 and status='completed';
  return jsonb_build_object('job_id',j.id,'batch_id',j.batch_id,'lease_id',j.lease_id,'lease_until',j.lease_until,'input_sha256',b.input_sha256,'snapshot',b.snapshot,'round',j.round,'peers',peers,'expected_model',j.expected_model,'family',w.family,'synthetic',b.synthetic);
end $$;

revoke all on function public.council_subscription_claim(text) from public,anon,authenticated;
grant execute on function public.council_subscription_claim(text) to service_role;
