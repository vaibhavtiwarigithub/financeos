-- Publish each successful hybrid subscription member forecast as soon as the
-- immutable worker result is accepted. The all-selected-members gate still
-- controls run completion and consensus; no partial median is created.
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

  -- Hybrid has no debate rounds. Persist each completed member independently so
  -- its score is available to symbol pages and the per-model evaluator while a
  -- peer remains queued. forecast_available_at remains the actual submit time.
  if b.run_id is not null and b.execution_mode='hybrid' and b.debate_rounds=0 then
    for j in select * from public.llm_council_jobs where batch_id=b.id and round=0 and status='completed' loop
      select value into m from jsonb_array_elements(b.members) where value->>'id'=j.worker_id::text;
      insert into public.llm_council_model_forecasts(run_id,model_requested,model_used,provider,initial_score,final_score,confidence,initial_rationale,final_rationale,bull_case,bear_case,evidence_citations,status,execution_source,available_at)
      values(b.run_id,j.expected_model,j.actual_model,m->>'family',
        (j.result->>'score')::numeric,(j.result->>'score')::numeric,(j.result->>'confidence')::numeric,
        j.result->>'rationale',j.result->>'rationale',j.result->>'bull_case',j.result->>'bear_case',j.result->'evidence_citations','completed','subscription',j.submitted_at)
      on conflict (run_id,model_requested,execution_source) do nothing;
    end loop;
  end if;

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
        first_j.result->>'rationale',j.result->>'rationale',j.result->>'bull_case',j.result->>'bear_case',j.result->'evidence_citations','completed','subscription',j.submitted_at)
      on conflict (run_id,model_requested,execution_source) do nothing;
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
      consensus_summary=case when med is null then 'Incomplete council; no consensus.' when b.execution_mode='hybrid' then 'Deterministic median across API and subscription members. API usage is bounded by the configured budget; personal membership workers use no OpenAI/Anthropic API billing.' else 'Deterministic median of all selected subscription workers. Subscription allowance used; API billing not invoked.' end,
      tokens_in=coalesce((select sum(tokens_in) from public.llm_council_turns where run_id=b.run_id),0)+coalesce((select sum(tokens_in) from public.llm_council_jobs where batch_id=b.id),0),
      tokens_out=coalesce((select sum(tokens_out) from public.llm_council_turns where run_id=b.run_id),0)+coalesce((select sum(tokens_out) from public.llm_council_jobs where batch_id=b.id),0),
      cost_usd=coalesce((select sum(cost_usd) from public.llm_council_turns where run_id=b.run_id),0),
      failure_code=case when final_status='completed' then null else 'subscription_'||final_status end,completed_at=now()
      where id=b.run_id and status='running';
  end if;
end $$;
