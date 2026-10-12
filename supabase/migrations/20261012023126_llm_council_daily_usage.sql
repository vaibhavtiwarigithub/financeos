-- Bounded, complete daily usage read model for the owner-only LLM council UI.
-- Usage is sourced from the immutable council turn/job ledgers; no forecasts,
-- scores, execution settings, or trading tables are modified.

create index if not exists llm_council_turns_created_run_idx
  on public.llm_council_turns (created_at, run_id);

create index if not exists llm_council_jobs_created_batch_idx
  on public.llm_council_jobs (created_at, batch_id);

create or replace function public.llm_council_daily_usage(p_days integer default 30)
returns table (
  usage_date date,
  market text,
  execution_source text,
  model_requested text,
  model_actual text,
  role text,
  record_count integer,
  failure_count integer,
  input_tokens bigint,
  output_tokens bigint,
  input_unknown_records integer,
  output_unknown_records integer,
  estimated_api_cost_usd numeric,
  lease_attempts integer,
  timestamp_basis text
)
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if p_days not in (7, 30, 90) then
    raise exception 'days_must_be_7_30_or_90';
  end if;

  return query
  with api_turns as (
    select
      (t.created_at at time zone case r.market
        when 'india' then 'Asia/Kolkata'
        else 'America/New_York'
      end)::date as local_day,
      r.market,
      'api'::text as source,
      t.model_requested,
      coalesce(t.model_used, 'not returned') as model_actual,
      t.turn_role as usage_role,
      t.status,
      case when t.model_used is null then 0 else t.tokens_in end::bigint as in_tokens,
      case when t.model_used is null then 0 else t.tokens_out end::bigint as out_tokens,
      (t.model_used is null and position('provider_key_missing:' in coalesce(t.output_text, '')) = 0
        and position('prompt_too_large' in coalesce(t.output_text, '')) = 0)::integer as input_unknown,
      (t.model_used is null and position('provider_key_missing:' in coalesce(t.output_text, '')) = 0
        and position('prompt_too_large' in coalesce(t.output_text, '')) = 0)::integer as output_unknown,
      case when t.model_used is not null then t.cost_usd
        when position('provider_key_missing:' in coalesce(t.output_text, '')) > 0
          or position('prompt_too_large' in coalesce(t.output_text, '')) > 0 then 0::numeric
        else null::numeric end as api_cost,
      0::integer as attempts,
      'turn recorded at'::text as time_basis
    from public.llm_council_turns t
    join public.llm_council_runs r on r.id = t.run_id
    where coalesce(r.config_snapshot->>'execution_mode', 'api') = 'api'
      and t.created_at >= now() - pg_catalog.make_interval(days => p_days + 2)
      and (t.created_at at time zone case r.market
        when 'india' then 'Asia/Kolkata'
        else 'America/New_York'
      end)::date >= ((now() at time zone case r.market
        when 'india' then 'Asia/Kolkata'
        else 'America/New_York'
      end)::date - (p_days - 1))
  ),
  subscription_jobs as (
    select
      (coalesce(j.submitted_at, j.created_at) at time zone case r.market
        when 'india' then 'Asia/Kolkata'
        else 'America/New_York'
      end)::date as local_day,
      r.market,
      'subscription'::text as source,
      j.expected_model as model_requested,
      coalesce(j.actual_model, j.expected_model) as model_actual,
      (w.family || '_worker')::text as usage_role,
      j.status,
      coalesce(j.tokens_in, 0)::bigint as in_tokens,
      coalesce(j.tokens_out, 0)::bigint as out_tokens,
      (j.tokens_in is null)::integer as input_unknown,
      (j.tokens_out is null)::integer as output_unknown,
      null::numeric as api_cost,
      coalesce(j.attempts, 0)::integer as attempts,
      case when j.submitted_at is null then 'queued/lease day; result time unavailable'
        else 'result reported at' end::text as time_basis
    from public.llm_council_jobs j
    join public.llm_council_batches b on b.id = j.batch_id
    join public.llm_council_runs r on r.id = b.run_id
    join public.llm_council_workers w on w.id = j.worker_id
    where not b.synthetic
      and j.status in ('completed', 'failed', 'expired')
      and j.created_at >= now() - pg_catalog.make_interval(days => p_days + 2)
      and (coalesce(j.submitted_at, j.created_at) at time zone case r.market
        when 'india' then 'Asia/Kolkata'
        else 'America/New_York'
      end)::date >= ((now() at time zone case r.market
        when 'india' then 'Asia/Kolkata'
        else 'America/New_York'
      end)::date - (p_days - 1))
  ),
  all_records as (
    select * from api_turns
    union all
    select * from subscription_jobs
  )
  select
    a.local_day,
    a.market,
    a.source,
    a.model_requested,
    a.model_actual,
    a.usage_role,
    count(*)::integer,
    count(*) filter (where a.status <> 'completed')::integer,
    coalesce(sum(a.in_tokens), 0)::bigint,
    coalesce(sum(a.out_tokens), 0)::bigint,
    coalesce(sum(a.input_unknown), 0)::integer,
    coalesce(sum(a.output_unknown), 0)::integer,
    case when a.source = 'api' then
      case when bool_or(a.api_cost is null) then null::numeric else coalesce(sum(a.api_cost), 0)::numeric end
      else null::numeric end,
    coalesce(sum(a.attempts), 0)::integer,
    case when a.source = 'api' then 'turn recorded at'
      when bool_or(a.time_basis <> 'result reported at') then 'mixed: result-reported and queued/lease dates'
      else 'result reported at' end::text
  from all_records a
  where a.local_day <= (now() at time zone case a.market
      when 'india' then 'Asia/Kolkata'
      else 'America/New_York'
    end)::date
  group by a.local_day, a.market, a.source, a.model_requested, a.model_actual, a.usage_role
  order by a.local_day desc, a.market, a.source, a.model_requested, a.usage_role;
end;
$$;

revoke all on function public.llm_council_daily_usage(integer) from public, anon, authenticated;
grant execute on function public.llm_council_daily_usage(integer) to service_role;
