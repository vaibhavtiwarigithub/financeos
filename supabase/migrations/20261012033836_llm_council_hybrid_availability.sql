-- Enable a cost-bounded API + official-client subscription roster while
-- retaining the council's shadow-only boundary. Delayed-client outcomes use a
-- separate availability-close cohort; existing observation-time IC is not
-- reinterpreted.
alter table public.llm_council_config
  drop constraint if exists llm_council_config_execution_mode_check;
alter table public.llm_council_config
  add constraint llm_council_config_execution_mode_check
  check (execution_mode in ('api', 'subscription', 'hybrid'));

alter table public.llm_council_model_forecasts
  add column execution_source text not null default 'api'
    check (execution_source in ('api', 'subscription')),
  add column available_at timestamptz;
alter table public.llm_council_model_forecasts
  drop constraint if exists llm_council_model_forecasts_run_id_model_requested_key;
alter table public.llm_council_model_forecasts
  add constraint llm_council_model_forecasts_run_model_source_key
  unique (run_id, model_requested, execution_source);
create index if not exists llm_council_forecasts_delayed_eval_idx
  on public.llm_council_model_forecasts (execution_source, status, available_at, run_id);

alter table public.llm_council_batches
  add column execution_mode text not null default 'subscription'
    check (execution_mode in ('subscription', 'hybrid')),
  add column api_models text[] not null default '{}';

-- Historical forecast rows are append-only and are intentionally not rewritten.
-- Only worker forecasts inserted by the new advance RPC receive source and
-- availability provenance. Legacy subscription runs remain outside the new
-- delayed cohort because they cannot be point-in-time relabelled safely.

create or replace function public.council_subscription_enqueue(
  p_source_key text, p_snapshot jsonb, p_hash text, p_worker_ids uuid[], p_rounds integer,
  p_observation_id bigint default null
) returns uuid language plpgsql security invoker set search_path = '' as $$
declare
  c public.llm_council_config; b uuid; r uuid; members jsonb; count_workers integer; m jsonb;
  selected_mode text; selected_api_models text[];
begin
  select * into c from public.llm_council_config where id='global' for update;
  if c.id is null then raise exception 'council_config_missing'; end if;
  select id into b from public.llm_council_batches where source_key=p_source_key;
  if b is not null then return b; end if;
  if p_source_key is null or length(p_source_key)>200 or p_hash is null or p_hash !~ '^[a-f0-9]{64}$'
    or p_snapshot is null or jsonb_typeof(p_snapshot)<>'object'
    or p_snapshot->>'market' is null or p_snapshot->>'market' not in ('us','india') or nullif(p_snapshot->>'symbol','') is null
    or p_snapshot->>'observed_at' is null then
    raise exception 'invalid_source_or_packet_hash';
  end if;
  if p_rounds is null or p_rounds not between 0 and 3 or coalesce(cardinality(p_worker_ids),0) not between 1 and 5 then raise exception 'invalid_roster'; end if;
  select count(*), jsonb_agg(jsonb_build_object('id',id,'family',family,'expected_model',expected_model) order by id)
    into count_workers,members from public.llm_council_workers where id=any(p_worker_ids) and revoked_at is null;
  if count_workers <> cardinality(p_worker_ids) then raise exception 'worker_unavailable_or_duplicate'; end if;
  if count_workers>1 and (select count(distinct value->>'family') from jsonb_array_elements(members))<2 then raise exception 'two_families_required'; end if;
  if (select count(distinct value->>'expected_model') from jsonb_array_elements(members))<>count_workers then raise exception 'duplicate_model'; end if;
  if p_observation_id is not null then
    if not c.enabled or c.execution_mode not in ('subscription','hybrid') or c.subscription_worker_ids<>p_worker_ids then raise exception 'subscription_disabled_or_roster_changed'; end if;
    selected_mode := c.execution_mode;
    selected_api_models := case when c.execution_mode='hybrid' then c.participant_models else '{}'::text[] end;
    if cardinality(selected_api_models) + count_workers > 5 then raise exception 'council_roster_limit'; end if;
    if exists(select 1 from unnest(selected_api_models) as model where model in (select value->>'expected_model' from jsonb_array_elements(members))) then raise exception 'duplicate_model_across_sources'; end if;
    if (select count(*) from public.llm_council_runs where market=p_snapshot->>'market' and created_at>=date_trunc('day',now() at time zone 'UTC') at time zone 'UTC') >= c.max_symbols_per_market_day then raise exception 'daily_symbol_cap'; end if;
    if selected_mode='hybrid' then
      select id into r from public.llm_council_runs where observation_id=p_observation_id and status='running' and input_sha256=p_hash;
      if r is null then raise exception 'hybrid_api_run_missing'; end if;
      if (select config_snapshot->>'execution_mode' from public.llm_council_runs where id=r)<>'hybrid'
        or (select config_snapshot->'participant_models' from public.llm_council_runs where id=r)<>to_jsonb(selected_api_models) then
        raise exception 'hybrid_api_roster_mismatch';
      end if;
    else
      insert into public.llm_council_runs(observation_id,market,symbol,decision_ts,status,input_snapshot,input_sha256,config_snapshot,prompt_version)
      values(p_observation_id,p_snapshot->>'market',p_snapshot->>'symbol',(p_snapshot->>'observed_at')::timestamptz,'running',p_snapshot,p_hash,
        jsonb_build_object('execution_mode','subscription','cohort_key','subscription_forward_v1','subscription_worker_ids',p_worker_ids,'members',members,'debate_rounds',p_rounds,'evaluation_state','awaiting_availability_aligned_labels'),'subscription-v1') returning id into r;
    end if;
  else
    selected_mode := 'subscription'; selected_api_models := '{}'::text[];
    if p_snapshot->>'symbol'<>'TEST-NO-REAL-ASSET' then raise exception 'synthetic_symbol_required'; end if;
    if (select count(*) from public.llm_council_batches where synthetic and created_at>now()-interval '1 day')>=5 then raise exception 'synthetic_daily_cap'; end if;
  end if;
  insert into public.llm_council_batches(source_key,run_id,synthetic,snapshot,input_sha256,members,debate_rounds,execution_mode,api_models)
  values(p_source_key,r,p_observation_id is null,p_snapshot,p_hash,members,case when count_workers=1 then 0 else p_rounds end,selected_mode,selected_api_models) returning id into b;
  for m in select value from jsonb_array_elements(members) loop
    insert into public.llm_council_jobs(batch_id,worker_id,round,expected_model) values(b,(m->>'id')::uuid,0,m->>'expected_model');
  end loop;
  return b;
end $$;

create or replace function public.council_subscription_advance(p_batch uuid) returns void
language plpgsql security invoker set search_path = '' as $$
declare b public.llm_council_batches; stage integer; good integer; total integer; m jsonb; j public.llm_council_jobs; first_j public.llm_council_jobs;
  final_status text; med numeric; expected_total integer; actual_total integer;
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
  update public.llm_council_batches set status=final_status,completed_at=now() where id=b.id;
  if b.run_id is not null then
    for first_j in select * from public.llm_council_jobs where batch_id=b.id and round=0 and status='completed' loop
      select * into j from public.llm_council_jobs where batch_id=b.id and worker_id=first_j.worker_id and status='completed' order by round desc limit 1;
      select value into m from jsonb_array_elements(b.members) where value->>'id'=j.worker_id::text;
      insert into public.llm_council_model_forecasts(run_id,model_requested,model_used,provider,initial_score,final_score,confidence,initial_rationale,final_rationale,bull_case,bear_case,evidence_citations,status,execution_source,available_at)
      values(b.run_id,j.expected_model,j.actual_model,m->>'family',
        (first_j.result->>'score')::numeric,(j.result->>'score')::numeric,(j.result->>'confidence')::numeric,
        first_j.result->>'rationale',j.result->>'rationale',j.result->>'bull_case',j.result->>'bear_case',j.result->'evidence_citations','completed','subscription',j.submitted_at);
    end loop;
    if b.execution_mode='hybrid' then
      select cardinality(b.api_models)+jsonb_array_length(b.members),count(*) filter(where status='completed' and final_score is not null)
        into expected_total,actual_total from public.llm_council_model_forecasts where run_id=b.run_id;
      if final_status='completed' and actual_total=expected_total then
        select percentile_cont(0.5) within group(order by final_score) into med from public.llm_council_model_forecasts where run_id=b.run_id and status='completed';
      else final_status := 'partial'; end if;
    elsif final_status='completed' then
      select percentile_cont(0.5) within group(order by (result->>'score')::numeric) into med from public.llm_council_jobs where batch_id=b.id and round=stage;
    end if;
    update public.llm_council_runs set status=case when final_status='completed' then 'completed' else 'partial' end,
      consensus_score=med,
      consensus_summary=case when med is null then 'Incomplete council; no consensus.' when b.execution_mode='hybrid' then 'Deterministic median across API and subscription members. API usage is bounded by the configured budget; personal membership workers use no OpenAI/Anthropic API billing.' else 'Deterministic median of selected subscription workers. Subscription allowance used; API billing not invoked.' end,
      tokens_in=coalesce((select sum(tokens_in) from public.llm_council_turns where run_id=b.run_id),0)+coalesce((select sum(tokens_in) from public.llm_council_jobs where batch_id=b.id),0),
      tokens_out=coalesce((select sum(tokens_out) from public.llm_council_turns where run_id=b.run_id),0)+coalesce((select sum(tokens_out) from public.llm_council_jobs where batch_id=b.id),0),
      cost_usd=coalesce((select sum(cost_usd) from public.llm_council_turns where run_id=b.run_id),0),
      failure_code=case when final_status='completed' then null else 'subscription_'||final_status end,completed_at=now()
      where id=b.run_id and status='running';
  end if;
end $$;

-- Existing subscription-only gates remain; hybrid is admitted only while the
-- owner has explicitly enabled that mode and selected worker roster.
create or replace function public.council_subscription_claim(p_token_hash text) returns jsonb
language plpgsql security invoker set search_path = '' as $$
declare w public.llm_council_workers; j public.llm_council_jobs; b public.llm_council_batches; peers jsonb;
begin
  select * into w from public.llm_council_workers where token_sha256=p_token_hash and revoked_at is null for update;
  if not found then raise exception 'unauthorized_worker'; end if;
  update public.llm_council_workers set last_seen_at=now() where id=w.id;
  if exists(select 1 from public.llm_council_jobs x join public.llm_council_batches y on y.id=x.batch_id where x.worker_id=w.id and x.status='leased' and x.lease_until>now() and y.status='running' and y.deadline>now()) then return null; end if;
  select x.* into j from public.llm_council_jobs x join public.llm_council_batches y on y.id=x.batch_id
   where x.worker_id=w.id and y.status='running' and y.deadline>now()
    and (y.synthetic or exists(select 1 from public.llm_council_config where id='global' and enabled and execution_mode=y.execution_mode and execution_mode in ('subscription','hybrid') and w.id=any(subscription_worker_ids)))
    and (x.status='queued' or (x.status='leased' and x.lease_until<=now() and x.attempts<2))
   order by x.created_at,x.id limit 1 for update of x skip locked;
  if not found then return null; end if;
  select * into b from public.llm_council_batches where id=j.batch_id;
  if j.status<>'leased' or j.lease_until<=now() then update public.llm_council_jobs set status='leased',lease_id=gen_random_uuid(),lease_until=least(b.deadline,now()+interval '10 minutes'),attempts=attempts+1 where id=j.id returning * into j; end if;
  select coalesce(jsonb_agg(jsonb_build_object('forecast',result) order by worker_id),'[]'::jsonb) into peers from public.llm_council_jobs where batch_id=b.id and round=j.round-1 and status='completed';
  return jsonb_build_object('job_id',j.id,'batch_id',b.id,'lease_id',j.lease_id,'lease_until',j.lease_until,'input_sha256',b.input_sha256,'snapshot',b.snapshot,'round',j.round,'peers',peers,'expected_model',j.expected_model,'family',w.family,'synthetic',b.synthetic);
end $$;

create or replace function public.council_subscription_submit(p_token_hash text,p_job uuid,p_lease uuid,p_hash text,p_result jsonb,p_result_hash text,p_actual_model text,p_tokens_in integer default null,p_tokens_out integer default null,p_failure text default null)
returns text language plpgsql security invoker set search_path = '' as $$
declare w public.llm_council_workers; j public.llm_council_jobs; b public.llm_council_batches;
begin
  select * into w from public.llm_council_workers where token_sha256=p_token_hash and revoked_at is null for update;
  if not found then raise exception 'unauthorized_worker'; end if;
  select * into j from public.llm_council_jobs where id=p_job and worker_id=w.id;
  if not found then raise exception 'unknown_job'; end if;
  select * into b from public.llm_council_batches where id=j.batch_id for update;
  select * into j from public.llm_council_jobs where id=p_job for update;
  if j.status in ('completed','failed') then if j.lease_id=p_lease and b.input_sha256=p_hash and j.result_sha256=p_result_hash then return 'already_accepted'; end if; raise exception 'result_conflict'; end if;
  if b.status<>'running' or b.deadline<=now() or j.status<>'leased' or j.lease_id is distinct from p_lease or j.lease_until<=now() or b.input_sha256<>p_hash then raise exception 'invalid_or_expired_lease'; end if;
  if not b.synthetic and not exists(select 1 from public.llm_council_config where id='global' and enabled and execution_mode=b.execution_mode and execution_mode in ('subscription','hybrid') and w.id=any(subscription_worker_ids)) then raise exception 'subscription_disabled'; end if;
  if p_actual_model is distinct from j.expected_model then raise exception 'model_mismatch'; end if;
  if p_failure is null and (jsonb_typeof(p_result->'score') is distinct from 'number' or (p_result->>'score')::numeric not between 0 and 100 or jsonb_typeof(p_result->'confidence') is distinct from 'number' or (p_result->>'confidence')::numeric not between 0 and 1) then raise exception 'invalid_forecast'; end if;
  update public.llm_council_jobs set status=case when p_failure is null then 'completed' else 'failed' end,result=p_result,result_sha256=p_result_hash,actual_model=p_actual_model,tokens_in=p_tokens_in,tokens_out=p_tokens_out,failure_code=p_failure,submitted_at=now() where id=j.id;
  perform public.council_subscription_advance(b.id);
  return 'accepted';
end $$;

revoke all on function public.council_subscription_enqueue(text,jsonb,text,uuid[],integer,bigint),public.council_subscription_advance(uuid),public.council_subscription_claim(text),public.council_subscription_submit(text,uuid,uuid,text,jsonb,text,text,integer,integer,text) from public,anon,authenticated;
grant execute on function public.council_subscription_enqueue(text,jsonb,text,uuid[],integer,bigint),public.council_subscription_advance(uuid),public.council_subscription_claim(text),public.council_subscription_submit(text,uuid,uuid,text,jsonb,text,text,integer,integer,text) to service_role;

-- The dated-usage read model must include API turns from hybrid runs without
-- charging subscription jobs a fabricated API cost.
create or replace function public.llm_council_daily_usage(p_days integer default 30)
returns table (
  usage_date date, market text, execution_source text, model_requested text, model_actual text, role text,
  record_count integer, failure_count integer, input_tokens bigint, output_tokens bigint,
  input_unknown_records integer, output_unknown_records integer, estimated_api_cost_usd numeric,
  lease_attempts integer, timestamp_basis text
)
language plpgsql security invoker set search_path = '' as $$
begin
  if p_days not in (7, 30, 90) then raise exception 'days_must_be_7_30_or_90'; end if;
  return query
  with api_turns as (
    select (t.created_at at time zone case r.market when 'india' then 'Asia/Kolkata' else 'America/New_York' end)::date as local_day,
      r.market,'api'::text as source,t.model_requested,coalesce(t.model_used,'not returned') as model_actual,t.turn_role as usage_role,t.status,
      case when t.model_used is null then 0 else t.tokens_in end::bigint as in_tokens,
      case when t.model_used is null then 0 else t.tokens_out end::bigint as out_tokens,
      (t.model_used is null and position('provider_key_missing:' in coalesce(t.output_text,''))=0 and position('prompt_too_large' in coalesce(t.output_text,''))=0)::integer as input_unknown,
      (t.model_used is null and position('provider_key_missing:' in coalesce(t.output_text,''))=0 and position('prompt_too_large' in coalesce(t.output_text,''))=0)::integer as output_unknown,
      case when t.model_used is not null then t.cost_usd when position('provider_key_missing:' in coalesce(t.output_text,''))>0 or position('prompt_too_large' in coalesce(t.output_text,''))>0 then 0::numeric else null::numeric end as api_cost,
      0::integer as attempts,'turn recorded at'::text as time_basis
    from public.llm_council_turns t join public.llm_council_runs r on r.id=t.run_id
    where coalesce(r.config_snapshot->>'execution_mode','api') in ('api','hybrid')
      and t.created_at>=now()-pg_catalog.make_interval(days=>p_days+2)
      and (t.created_at at time zone case r.market when 'india' then 'Asia/Kolkata' else 'America/New_York' end)::date >= ((now() at time zone case r.market when 'india' then 'Asia/Kolkata' else 'America/New_York' end)::date-(p_days-1))
  ),
  subscription_jobs as (
    select (coalesce(j.submitted_at,j.created_at) at time zone case r.market when 'india' then 'Asia/Kolkata' else 'America/New_York' end)::date as local_day,
      r.market,'subscription'::text as source,j.expected_model,coalesce(j.actual_model,j.expected_model) as model_actual,(w.family||'_worker')::text as usage_role,j.status,
      coalesce(j.tokens_in,0)::bigint as in_tokens,coalesce(j.tokens_out,0)::bigint as out_tokens,(j.tokens_in is null)::integer as input_unknown,(j.tokens_out is null)::integer as output_unknown,
      null::numeric as api_cost,coalesce(j.attempts,0)::integer as attempts,
      case when j.submitted_at is null then 'queued/lease day; result time unavailable' else 'result reported at' end::text as time_basis
    from public.llm_council_jobs j join public.llm_council_batches b on b.id=j.batch_id join public.llm_council_runs r on r.id=b.run_id join public.llm_council_workers w on w.id=j.worker_id
    where not b.synthetic and j.status in ('completed','failed','expired') and j.created_at>=now()-pg_catalog.make_interval(days=>p_days+2)
      and (coalesce(j.submitted_at,j.created_at) at time zone case r.market when 'india' then 'Asia/Kolkata' else 'America/New_York' end)::date >= ((now() at time zone case r.market when 'india' then 'Asia/Kolkata' else 'America/New_York' end)::date-(p_days-1))
  ), all_records as (select * from api_turns union all select * from subscription_jobs)
  select a.local_day,a.market,a.source,a.model_requested,a.model_actual,a.usage_role,count(*)::integer,
    count(*) filter(where a.status<>'completed')::integer,coalesce(sum(a.in_tokens),0)::bigint,coalesce(sum(a.out_tokens),0)::bigint,
    coalesce(sum(a.input_unknown),0)::integer,coalesce(sum(a.output_unknown),0)::integer,
    case when a.source='api' then case when bool_or(a.api_cost is null) then null::numeric else coalesce(sum(a.api_cost),0)::numeric end else null::numeric end,
    coalesce(sum(a.attempts),0)::integer,
    case when a.source='api' then 'turn recorded at' when bool_or(a.time_basis<>'result reported at') then 'mixed: result-reported and queued/lease dates' else 'result reported at' end::text
  from all_records a where a.local_day <= (now() at time zone case a.market when 'india' then 'Asia/Kolkata' else 'America/New_York' end)::date
  group by a.local_day,a.market,a.source,a.model_requested,a.model_actual,a.usage_role
  order by a.local_day desc,a.market,a.source,a.model_requested,a.usage_role;
end $$;
revoke all on function public.llm_council_daily_usage(integer) from public,anon,authenticated;
grant execute on function public.llm_council_daily_usage(integer) to service_role;
