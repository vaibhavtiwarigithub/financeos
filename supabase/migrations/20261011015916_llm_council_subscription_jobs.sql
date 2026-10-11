-- Subscription clients are external workers, never inference API credentials.
alter table public.llm_council_config
  add column execution_mode text not null default 'api' check (execution_mode in ('api','subscription')),
  add column subscription_worker_ids uuid[] not null default '{}' check (cardinality(subscription_worker_ids) <= 5);

create table public.llm_council_workers (
  id uuid primary key default gen_random_uuid(),
  label text not null check (length(label) between 1 and 80),
  family text not null check (family in ('codex','claude')),
  expected_model text not null check (length(expected_model) between 1 and 120),
  token_sha256 text not null unique check (token_sha256 ~ '^[a-f0-9]{64}$'),
  created_at timestamptz not null default now(),
  revoked_at timestamptz,
  last_seen_at timestamptz
);
create table public.llm_council_batches (
  id uuid primary key default gen_random_uuid(),
  source_key text not null unique,
  run_id uuid unique references public.llm_council_runs(id),
  synthetic boolean not null,
  snapshot jsonb not null,
  input_sha256 text not null,
  members jsonb not null check (jsonb_array_length(members) between 1 and 5),
  debate_rounds smallint not null check (debate_rounds between 0 and 3),
  status text not null default 'running' check (status in ('running','completed','partial','expired')),
  consensus_score numeric check (consensus_score between 0 and 100),
  created_at timestamptz not null default now(),
  deadline timestamptz not null default now() + interval '45 minutes',
  completed_at timestamptz,
  check ((synthetic and run_id is null) or (not synthetic and run_id is not null))
);
create table public.llm_council_jobs (
  id uuid primary key default gen_random_uuid(),
  batch_id uuid not null references public.llm_council_batches(id),
  worker_id uuid not null references public.llm_council_workers(id),
  round smallint not null check (round between 0 and 3),
  expected_model text not null,
  status text not null default 'queued' check (status in ('queued','leased','completed','failed','expired')),
  lease_id uuid,
  lease_until timestamptz,
  attempts smallint not null default 0 check (attempts between 0 and 2),
  result jsonb,
  result_sha256 text,
  actual_model text,
  tokens_in integer check (tokens_in >= 0),
  tokens_out integer check (tokens_out >= 0),
  failure_code text,
  submitted_at timestamptz,
  created_at timestamptz not null default now(),
  unique(batch_id, worker_id, round)
);
create index llm_council_jobs_claim_idx on public.llm_council_jobs(worker_id,status,created_at);
create index llm_council_batches_status_idx on public.llm_council_batches(status,deadline);
alter table public.llm_council_workers enable row level security;
alter table public.llm_council_batches enable row level security;
alter table public.llm_council_jobs enable row level security;
revoke all on public.llm_council_workers,public.llm_council_batches,public.llm_council_jobs from public,anon,authenticated;
grant all on public.llm_council_workers,public.llm_council_batches,public.llm_council_jobs to service_role;

create function public.council_subscription_enqueue(p_source_key text, p_snapshot jsonb, p_hash text,
 p_worker_ids uuid[], p_rounds integer, p_observation_id bigint default null)
returns uuid language plpgsql security invoker set search_path = '' as $$
declare c public.llm_council_config; b uuid; r uuid; members jsonb; count_workers integer; m jsonb;
begin
 select * into c from public.llm_council_config where id='global' for update;
 if c.id is null then raise exception 'council_config_missing'; end if;
 select id into b from public.llm_council_batches where source_key=p_source_key;
 if b is not null then return b; end if;
 if p_source_key is null or length(p_source_key)>200 or p_hash !~ '^[a-f0-9]{64}$' then raise exception 'invalid_source_or_packet_hash'; end if;
 if p_rounds not between 0 and 3 or coalesce(cardinality(p_worker_ids),0) not between 1 and 5 then raise exception 'invalid_roster'; end if;
 select count(*), jsonb_agg(jsonb_build_object('id',id,'family',family,'expected_model',expected_model) order by id)
 into count_workers,members from public.llm_council_workers where id=any(p_worker_ids) and revoked_at is null;
 if count_workers <> cardinality(p_worker_ids) then raise exception 'worker_unavailable_or_duplicate'; end if;
 if count_workers>1 and (select count(distinct value->>'family') from jsonb_array_elements(members))<2 then raise exception 'two_families_required'; end if;
 if (select count(distinct (value->>'family',value->>'expected_model')) from jsonb_array_elements(members))<>count_workers then raise exception 'duplicate_model'; end if;
 if p_observation_id is not null then
   if not c.enabled or c.execution_mode<>'subscription' or c.subscription_worker_ids<>p_worker_ids then raise exception 'subscription_disabled_or_roster_changed'; end if;
   if (select count(*) from public.llm_council_runs where market=p_snapshot->>'market' and created_at>=date_trunc('day',now() at time zone 'UTC') at time zone 'UTC') >= c.max_symbols_per_market_day then raise exception 'daily_symbol_cap'; end if;
   insert into public.llm_council_runs(observation_id,market,symbol,decision_ts,status,input_snapshot,input_sha256,config_snapshot,prompt_version)
   values(p_observation_id,p_snapshot->>'market',p_snapshot->>'symbol',(p_snapshot->>'observed_at')::timestamptz,'running',p_snapshot,p_hash,
     jsonb_build_object('execution_mode','subscription','cohort_key','subscription_forward_v1','subscription_worker_ids',p_worker_ids,'members',members,'debate_rounds',p_rounds,'evaluation_state','awaiting_availability_aligned_labels'),'subscription-v1') returning id into r;
 else
   if p_snapshot->>'symbol'<>'TEST-NO-REAL-ASSET' then raise exception 'synthetic_symbol_required'; end if;
   if (select count(*) from public.llm_council_batches where synthetic and created_at>now()-interval '1 day')>=5 then raise exception 'synthetic_daily_cap'; end if;
 end if;
 insert into public.llm_council_batches(source_key,run_id,synthetic,snapshot,input_sha256,members,debate_rounds)
 values(p_source_key,r,p_observation_id is null,p_snapshot,p_hash,members,case when count_workers=1 then 0 else p_rounds end) returning id into b;
 for m in select value from jsonb_array_elements(members) loop
   insert into public.llm_council_jobs(batch_id,worker_id,round,expected_model) values(b,(m->>'id')::uuid,0,m->>'expected_model');
 end loop;
 return b;
end $$;

create function public.council_subscription_advance(p_batch uuid) returns void
language plpgsql security invoker set search_path = '' as $$
declare b public.llm_council_batches; stage integer; good integer; total integer; m jsonb; j public.llm_council_jobs; first_j public.llm_council_jobs; final_status text; med numeric;
begin
 select * into b from public.llm_council_batches where id=p_batch for update;
 if not found or b.status<>'running' then return; end if;
 update public.llm_council_jobs set status='expired',failure_code='deadline_expired'
 where batch_id=b.id and status in ('queued','leased') and b.deadline<=now();
 select max(round) into stage from public.llm_council_jobs where batch_id=b.id;
 if exists(select 1 from public.llm_council_jobs where batch_id=b.id and round=stage and status in ('queued','leased')) then return; end if;
 select count(*) filter(where status='completed'),count(*) into good,total from public.llm_council_jobs where batch_id=b.id and round=stage;
 if total<>jsonb_array_length(b.members) then raise exception 'incomplete_stage'; end if;
 if good=total and stage<b.debate_rounds and b.deadline>now() then
   for m in select value from jsonb_array_elements(b.members) loop
     insert into public.llm_council_jobs(batch_id,worker_id,round,expected_model) values(b.id,(m->>'id')::uuid,stage+1,m->>'expected_model');
   end loop;
   return;
 end if;
 final_status := case when good=total and stage=b.debate_rounds then 'completed' when b.deadline<=now() then 'expired' else 'partial' end;
 if final_status='completed' then
   select percentile_cont(0.5) within group(order by (result->>'score')::numeric) into med from public.llm_council_jobs where batch_id=b.id and round=stage;
 end if;
 update public.llm_council_batches set status=final_status,consensus_score=med,completed_at=now() where id=b.id;
 if b.run_id is not null then
   for first_j in select * from public.llm_council_jobs where batch_id=b.id and round=0 and status='completed' loop
     select * into j from public.llm_council_jobs where batch_id=b.id and worker_id=first_j.worker_id and status='completed' order by round desc limit 1;
     select value into m from jsonb_array_elements(b.members) where value->>'id'=j.worker_id::text;
     insert into public.llm_council_model_forecasts(run_id,model_requested,model_used,provider,initial_score,final_score,confidence,initial_rationale,final_rationale,bull_case,bear_case,evidence_citations,status)
     values(b.run_id,'subscription-'||j.worker_id,j.actual_model,m->>'family',(first_j.result->>'score')::numeric,(j.result->>'score')::numeric,(j.result->>'confidence')::numeric,
      first_j.result->>'rationale',j.result->>'rationale',j.result->>'bull_case',j.result->>'bear_case',j.result->'evidence_citations','completed');
   end loop;
   update public.llm_council_runs set status=case when final_status='completed' then 'completed' else 'partial' end,
     consensus_score=med,consensus_summary=case when med is null then 'Incomplete subscription council; no consensus.' else 'Deterministic median of all selected subscription workers. Subscription allowance used; API billing not invoked.' end,
     failure_code=case when final_status='completed' then null else 'subscription_'||final_status end, completed_at=now() where id=b.run_id;
 end if;
end $$;

create function public.council_subscription_claim(p_token_hash text) returns jsonb
language plpgsql security invoker set search_path = '' as $$
declare w public.llm_council_workers; j public.llm_council_jobs; b public.llm_council_batches; peers jsonb;
begin
 select * into w from public.llm_council_workers where token_sha256=p_token_hash and revoked_at is null for update;
 if not found then raise exception 'unauthorized_worker'; end if;
 update public.llm_council_workers set last_seen_at=now() where id=w.id;
 -- One active invocation per worker. A second poll must not repeat inference.
 if exists(select 1 from public.llm_council_jobs x join public.llm_council_batches y on y.id=x.batch_id
   where x.worker_id=w.id and x.status='leased' and x.lease_until>now() and y.status='running' and y.deadline>now()) then return null; end if;
 select x.* into j from public.llm_council_jobs x join public.llm_council_batches y on y.id=x.batch_id
 where x.worker_id=w.id and y.status='running' and y.deadline>now()
   and (y.synthetic or exists(select 1 from public.llm_council_config where id='global' and enabled and execution_mode='subscription'))
   and ((x.status='queued') or (x.status='leased' and x.lease_until<=now() and x.attempts<2))
 order by x.created_at,x.id limit 1 for update of x skip locked;
 if not found then return null; end if;
 select * into b from public.llm_council_batches where id=j.batch_id;
 if j.status<>'leased' or j.lease_until<=now() then
   update public.llm_council_jobs set status='leased',lease_id=gen_random_uuid(),lease_until=least(b.deadline,now()+interval '10 minutes'),attempts=attempts+1
     where id=j.id returning * into j;
 end if;
 -- Do not expose stable worker IDs or provider identity across independent members.
 select coalesce(jsonb_agg(jsonb_build_object('forecast',result) order by worker_id),'[]'::jsonb) into peers
 from public.llm_council_jobs where batch_id=b.id and round=j.round-1 and status='completed';
 return jsonb_build_object('job_id',j.id,'batch_id',b.id,'lease_id',j.lease_id,'lease_until',j.lease_until,'input_sha256',b.input_sha256,
 'snapshot',b.snapshot,'round',j.round,'peers',peers,'expected_model',j.expected_model,'family',w.family,'synthetic',b.synthetic);
end $$;

create function public.council_subscription_submit(p_token_hash text,p_job uuid,p_lease uuid,p_hash text,p_result jsonb,p_result_hash text,p_actual_model text,p_tokens_in integer default null,p_tokens_out integer default null,p_failure text default null)
returns text language plpgsql security invoker set search_path = '' as $$
declare w public.llm_council_workers; j public.llm_council_jobs; b public.llm_council_batches;
begin
 select * into w from public.llm_council_workers where token_sha256=p_token_hash and revoked_at is null for update;
 if not found then raise exception 'unauthorized_worker'; end if;
 select * into j from public.llm_council_jobs where id=p_job and worker_id=w.id;
 if not found then raise exception 'unknown_job'; end if;
 -- Same lock order as progression: batch before job.
 select * into b from public.llm_council_batches where id=j.batch_id for update;
 select * into j from public.llm_council_jobs where id=p_job for update;
 if j.status in ('completed','failed') then
   if j.lease_id=p_lease and b.input_sha256=p_hash and j.result_sha256=p_result_hash then return 'already_accepted'; end if;
   raise exception 'result_conflict';
 end if;
 if b.status<>'running' or b.deadline<=now() or j.status<>'leased' or j.lease_id is distinct from p_lease or j.lease_until<=now() or b.input_sha256<>p_hash then raise exception 'invalid_or_expired_lease'; end if;
 if not b.synthetic and not exists(select 1 from public.llm_council_config where id='global' and enabled and execution_mode='subscription') then raise exception 'subscription_disabled'; end if;
 if p_actual_model is distinct from j.expected_model then raise exception 'model_mismatch'; end if;
 if p_failure is null and (jsonb_typeof(p_result->'score') is distinct from 'number' or (p_result->>'score')::numeric not between 0 and 100 or jsonb_typeof(p_result->'confidence') is distinct from 'number' or (p_result->>'confidence')::numeric not between 0 and 1) then raise exception 'invalid_forecast'; end if;
 update public.llm_council_jobs set status=case when p_failure is null then 'completed' else 'failed' end,result=p_result,result_sha256=p_result_hash,actual_model=p_actual_model,
 tokens_in=p_tokens_in,tokens_out=p_tokens_out,failure_code=p_failure,submitted_at=now() where id=j.id;
 perform public.council_subscription_advance(b.id);
 return 'accepted';
end $$;

revoke all on function public.council_subscription_enqueue(text,jsonb,text,uuid[],integer,bigint),public.council_subscription_advance(uuid),public.council_subscription_claim(text),public.council_subscription_submit(text,uuid,uuid,text,jsonb,text,text,integer,integer,text) from public,anon,authenticated;
grant execute on function public.council_subscription_enqueue(text,jsonb,text,uuid[],integer,bigint),public.council_subscription_advance(uuid),public.council_subscription_claim(text),public.council_subscription_submit(text,uuid,uuid,text,jsonb,text,text,integer,integer,text) to service_role;
