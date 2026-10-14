-- Insider score v2 shadow (measure-only). Computes the live insider score's logic (v1) and a variant that ignores Rule 10b5-1 planned sales (v2)
-- from the SAME SEC Form 4 filings, so the comparison is paired. Nothing in scoring, gates or trading reads these tables. The variant is
-- pre-registered in score_variant_registry (immutable, declared_at) and judged by the same forward-only evaluator machinery.

create table if not exists public.insider_v2_shadow (
  id bigint generated always as identity primary key,
  symbol text not null,
  as_of date not null,
  computed_at timestamptz not null default now(),
  lookback_days int not null default 90,
  filings_attempted int not null,
  filings_failed int not null,
  buy_count int not null, buy_value numeric not null,
  planned_sell_count int not null, planned_sell_value numeric not null,
  discretionary_sell_count int not null, discretionary_sell_value numeric not null,
  unknown_sell_count int not null, unknown_sell_value numeric not null,
  v1_score numeric, v1_available boolean not null,
  v2_score numeric, v2_available boolean not null,
  unique (symbol, as_of)
);
create index if not exists insider_v2_shadow_idx on public.insider_v2_shadow (as_of desc, symbol);
alter table public.insider_v2_shadow enable row level security;
revoke all on public.insider_v2_shadow from anon, authenticated;
drop trigger if exists insider_v2_shadow_no_change on public.insider_v2_shadow;
create trigger insider_v2_shadow_no_change before update or delete on public.insider_v2_shadow for each row execute function public.llm_event_append_only();

insert into public.score_variant_registry (variant_set, variant_id, label, weights, rationale) values
  ('insider_v2', 'insider_v2_discretionary', 'Insider v2 (ignores planned sales)', '{"insider_v2":1}',
   '2026-10-14 audit: the live insider score was negative in both halves (spread -0.14%, -1.81%) and scores routine Rule 10b5-1 selling as bearish. v2 counts open-market buys plus discretionary sales only. Judged against insider v1 computed from the same filings.')
on conflict do nothing;

-- Producer: weekdays 12:00, 12:20, 12:40, 13:00 UTC (idempotent; each run resumes where the last stopped within its time budget).
select cron.schedule('kairos-insider-v2-shadow-a', '0,20,40 12 * * 1-5',
  $$select public.kairos_call_agent('/api/agents/insider-v2-shadow', '{}'::jsonb, 'POST', 120000)$$);
select cron.schedule('kairos-insider-v2-shadow-b', '0 13 * * 1-5',
  $$select public.kairos_call_agent('/api/agents/insider-v2-shadow', '{}'::jsonb, 'POST', 120000)$$);
-- Evaluator: daily 15:20 UTC.
select cron.schedule('kairos-insider-v2-eval', '20 15 * * *',
  $$select public.kairos_call_agent('/api/agents/insider-v2-shadow/evaluate', '{}'::jsonb, 'POST', 120000)$$);
