-- Forward shadow of alternative score formulas (measure-only). Variants are pure functions of dimension scores already stored on every
-- decision observation, so there is no producer. Definitions are PRE-REGISTERED here (immutable) with declared_at; the evaluator judges
-- only observations dated after declared_at as "forward" and reports earlier ones separately as hindsight. Nothing in scoring, gates or
-- trading reads these tables.

create table if not exists public.score_variant_registry (
  variant_set text not null,
  variant_id text not null,
  label text not null,
  weights jsonb not null,
  declared_at timestamptz not null default now(),
  rationale text not null,
  primary key (variant_set, variant_id)
);
alter table public.score_variant_registry enable row level security;
revoke all on public.score_variant_registry from anon, authenticated;

create table if not exists public.score_variant_eval_runs (
  id bigint generated always as identity primary key,
  evaluation_batch_id uuid not null,
  evaluated_at timestamptz not null default now(),
  variant_set text not null,
  variant_id text not null,
  market text not null check (market in ('us', 'india')),
  sample text not null check (sample in ('forward', 'hindsight')),
  horizon_days int not null,
  sessions int not null,
  avg_cross_section numeric not null,
  independent_windows numeric not null,
  variant_mean_ic numeric, variant_ic_t numeric, variant_top_fifth numeric, variant_bottom_fifth numeric, variant_spread numeric, variant_spread_t numeric,
  baseline_mean_ic numeric, baseline_ic_t numeric, baseline_top_fifth numeric, baseline_bottom_fifth numeric, baseline_spread numeric, baseline_spread_t numeric,
  classification text not null check (classification in ('insufficient_evidence', 'measured_descriptive')),
  meets_adoption_gate boolean not null,
  reason text not null
);
create index if not exists score_variant_eval_runs_idx on public.score_variant_eval_runs (evaluated_at desc, market, sample, horizon_days, variant_id);
alter table public.score_variant_eval_runs enable row level security;
revoke all on public.score_variant_eval_runs from anon, authenticated;

drop trigger if exists score_variant_registry_no_change on public.score_variant_registry;
create trigger score_variant_registry_no_change before update or delete on public.score_variant_registry for each row execute function public.llm_event_append_only();
drop trigger if exists score_variant_eval_runs_no_change on public.score_variant_eval_runs;
create trigger score_variant_eval_runs_no_change before update or delete on public.score_variant_eval_runs for each row execute function public.llm_event_append_only();

insert into public.score_variant_registry (variant_set, variant_id, label, weights, rationale) values
  ('variant_set_v1', 'fundamental_only', 'Fundamental only', '{"fundamental":1}',
   '2026-10-14 audit: only score with a positive top-minus-bottom-fifth spread in both halves of the US window (+1.88%, +2.01%).'),
  ('variant_set_v1', 'fundamental_sentiment', 'Fundamental + sentiment', '{"fundamental":0.30,"sentiment":0.20}',
   '2026-10-14 audit: the two dimensions that ranked correctly over the full window; sentiment flipped between halves, so this is the higher-variance candidate.'),
  ('variant_set_v1', 'composite_ex_insider', 'Current composite without insider', '{"fundamental":0.30,"technical":0.25,"sentiment":0.20}',
   '2026-10-14 audit: insider scores routine selling as bearish and was negative in both halves; isolates the effect of removing only that dimension.')
on conflict do nothing;

-- 15:10 UTC daily, after US labels mature overnight.
select cron.schedule('kairos-score-variants-eval', '10 15 * * *',
  $$select public.kairos_call_agent('/api/agents/score-variants/evaluate', '{}'::jsonb, 'POST', 120000)$$);
