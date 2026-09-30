
-- Multi-LLM research council: owner-configurable and measurement-only.
-- Model outputs are never inputs to scores, sizing, execution, exits, or rotation.

create table public.llm_council_config (
  id text primary key default 'global' check (id = 'global'),
  enabled boolean not null default false,
  participant_models text[] not null default array['deepseek-flash','gemini-2.5-flash']::text[] check (cardinality(participant_models) between 2 and 3),
  orchestrator_model text not null default 'deepseek-flash',
  debate_rounds smallint not null default 1 check (debate_rounds between 0 and 3),
  max_symbols_per_market_day smallint not null default 5 check (max_symbols_per_market_day between 1 and 5),
  daily_budget_usd numeric(10,4) not null default 2.0000 check (daily_budget_usd between 0 and 100),
  prompt_version text not null default 'council-v1',
  updated_at timestamptz not null default now()
);
insert into public.llm_council_config(id) values ('global') on conflict (id) do nothing;

create table public.llm_council_runs (
  id uuid primary key default gen_random_uuid(),
  observation_id bigint not null unique references public.decision_observations(id),
  market text not null check (market in ('us','india')),
  symbol text not null,
  decision_ts timestamptz not null,
  status text not null check (status in ('running','completed','partial','failed','budget_skipped')),
  input_snapshot jsonb not null,
  input_sha256 text not null,
  config_snapshot jsonb not null,
  prompt_version text not null,
  consensus_score numeric(5,2) check (consensus_score between 0 and 100),
  consensus_summary text,
  disagreement_summary text,
  tokens_in integer not null default 0 check (tokens_in >= 0),
  tokens_out integer not null default 0 check (tokens_out >= 0),
  cost_usd numeric(12,6) not null default 0 check (cost_usd >= 0),
  failure_code text,
  created_at timestamptz not null default now(),
  completed_at timestamptz
);
create index llm_council_runs_market_created_idx on public.llm_council_runs(market, created_at desc);
create index llm_council_runs_symbol_created_idx on public.llm_council_runs(symbol, created_at desc);

create table public.llm_council_model_forecasts (
  id uuid primary key default gen_random_uuid(),
  run_id uuid not null references public.llm_council_runs(id),
  model_requested text not null,
  model_used text,
  provider text not null,
  initial_score numeric(5,2) check (initial_score between 0 and 100),
  final_score numeric(5,2) check (final_score between 0 and 100),
  confidence numeric(4,3) check (confidence between 0 and 1),
  initial_rationale text,
  final_rationale text,
  bull_case text,
  bear_case text,
  evidence_citations jsonb not null default '[]'::jsonb,
  status text not null check (status in ('completed','failed','fallback_mismatch','invalid_output')),
  created_at timestamptz not null default now(),
  unique(run_id, model_requested)
);
create index llm_council_forecasts_model_idx on public.llm_council_model_forecasts(model_requested, created_at desc);

create table public.llm_council_turns (
  id uuid primary key default gen_random_uuid(),
  run_id uuid not null references public.llm_council_runs(id),
  model_requested text not null,
  model_used text,
  turn_role text not null check (turn_role in ('independent','debate','orchestrator')),
  round smallint not null check (round between 0 and 3),
  prompt_sha256 text not null,
  output_json jsonb,
  output_text text,
  tokens_in integer not null default 0 check (tokens_in >= 0),
  tokens_out integer not null default 0 check (tokens_out >= 0),
  cost_usd numeric(12,6) not null default 0 check (cost_usd >= 0),
  status text not null check (status in ('completed','failed','fallback_mismatch','invalid_output')),
  created_at timestamptz not null default now(),
  unique(run_id, model_requested, turn_role, round)
);
create index llm_council_turns_run_idx on public.llm_council_turns(run_id, round);

create table public.llm_council_ic_runs (
  id uuid primary key default gen_random_uuid(),
  evaluation_batch_id uuid not null,
  market text not null check (market in ('us','india')),
  horizon_days integer not null check (horizon_days in (2,5,10,20)),
  series_key text not null,
  forecast_model text,
  cohort_key text not null default 'eligible_long',
  observation_count integer not null default 0 check (observation_count >= 0),
  qualifying_sessions integer not null default 0 check (qualifying_sessions >= 0),
  independent_windows numeric(12,4) not null default 0 check (independent_windows >= 0),
  mean_session_rank_ic numeric(10,7),
  sd_session_rank_ic numeric(10,7),
  t_stat numeric(12,5),
  classification text not null check (classification in ('insufficient_evidence','measured_descriptive')),
  reason text not null,
  evaluated_at timestamptz not null default now()
);
create index llm_council_ic_latest_idx on public.llm_council_ic_runs(market, horizon_days, series_key, evaluated_at desc);

-- Immutable evidence ledgers. Service-role API routes perform all writes.
create or replace function public.llm_council_block_mutation() returns trigger
language plpgsql set search_path = '' as $$
begin raise exception 'LLM council evidence is append-only'; end $$;
create or replace function public.llm_council_run_finalize_once() returns trigger
language plpgsql set search_path = '' as $$
begin
  if tg_op = 'DELETE' then raise exception 'LLM council run ledger is append-only'; end if;
  if old.status <> 'running' or new.status = 'running' then
    raise exception 'LLM council run can only transition once from running to a final status';
  end if;
  if (to_jsonb(new) - array['status','consensus_score','consensus_summary','disagreement_summary','tokens_in','tokens_out','cost_usd','failure_code','completed_at'])
     <> (to_jsonb(old) - array['status','consensus_score','consensus_summary','disagreement_summary','tokens_in','tokens_out','cost_usd','failure_code','completed_at']) then
    raise exception 'LLM council run snapshot fields are immutable';
  end if;
  return new;
end $$;
create trigger llm_council_runs_finalize_once before update or delete on public.llm_council_runs
for each row execute function public.llm_council_run_finalize_once();
create trigger llm_council_forecasts_immutable before update or delete on public.llm_council_model_forecasts
for each row execute function public.llm_council_block_mutation();
create trigger llm_council_turns_immutable before update or delete on public.llm_council_turns
for each row execute function public.llm_council_block_mutation();
create trigger llm_council_ic_immutable before update or delete on public.llm_council_ic_runs
for each row execute function public.llm_council_block_mutation();

alter table public.llm_council_config enable row level security;
alter table public.llm_council_runs enable row level security;
alter table public.llm_council_model_forecasts enable row level security;
alter table public.llm_council_turns enable row level security;
alter table public.llm_council_ic_runs enable row level security;

create policy llm_council_config_owner_read on public.llm_council_config
for select to authenticated using (((select auth.jwt()) ->> 'email') = 'vterminater@gmail.com');
create policy llm_council_runs_owner_read on public.llm_council_runs
for select to authenticated using (((select auth.jwt()) ->> 'email') = 'vterminater@gmail.com');
create policy llm_council_forecasts_owner_read on public.llm_council_model_forecasts
for select to authenticated using (((select auth.jwt()) ->> 'email') = 'vterminater@gmail.com');
create policy llm_council_turns_owner_read on public.llm_council_turns
for select to authenticated using (((select auth.jwt()) ->> 'email') = 'vterminater@gmail.com');
create policy llm_council_ic_owner_read on public.llm_council_ic_runs
for select to authenticated using (((select auth.jwt()) ->> 'email') = 'vterminater@gmail.com');

revoke all on public.llm_council_config, public.llm_council_runs,
  public.llm_council_model_forecasts, public.llm_council_turns,
  public.llm_council_ic_runs from anon, authenticated;
grant select on public.llm_council_config, public.llm_council_runs,
  public.llm_council_model_forecasts, public.llm_council_turns,
  public.llm_council_ic_runs to authenticated;
grant all on public.llm_council_config, public.llm_council_runs,
  public.llm_council_model_forecasts, public.llm_council_turns,
  public.llm_council_ic_runs to service_role;
