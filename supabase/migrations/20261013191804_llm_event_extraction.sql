-- LLM event extraction shadow (India, measure-only). One news/NSE item per model call, blind to price and scores.
-- Items and scores are append-only; nothing in scoring, gates or trades reads them. Default OFF.

create table if not exists public.llm_event_config (
  id text primary key default 'global' check (id = 'global'),
  enabled boolean not null default false,
  model text not null default 'deepseek-flash',
  daily_budget_usd numeric not null default 0.50,
  max_items_per_run int not null default 150,
  updated_at timestamptz not null default now()
);
insert into public.llm_event_config (id) values ('global') on conflict (id) do nothing;

create table if not exists public.llm_event_items (
  id bigint generated always as identity primary key,
  item_key text not null unique,
  symbol text not null,
  source text not null check (source in ('google_news_rss', 'nse_corporate_announcements')),
  published_at timestamptz,
  fetched_at timestamptz not null,
  status text not null check (status in ('ok', 'rejected')),
  reject_reason text,
  about_company boolean,
  event_type text,
  direction numeric,
  magnitude numeric,
  horizon text,
  quote text,
  doc_text text not null,
  model text,
  tokens_in int not null default 0,
  tokens_out int not null default 0,
  cost_usd numeric not null default 0,
  extracted_at timestamptz not null default now(),
  run_id text not null
);
create index if not exists llm_event_items_symbol_idx on public.llm_event_items (symbol, fetched_at desc);
create index if not exists llm_event_items_extracted_idx on public.llm_event_items (extracted_at desc);

create table if not exists public.llm_event_scores (
  id bigint generated always as identity primary key,
  symbol text not null,
  score numeric not null,
  n_items int not null,
  method text not null,
  as_of timestamptz not null,
  run_id text not null,
  unique (symbol, run_id)
);
create index if not exists llm_event_scores_symbol_idx on public.llm_event_scores (symbol, as_of desc);

alter table public.llm_event_config enable row level security;
alter table public.llm_event_items enable row level security;
alter table public.llm_event_scores enable row level security;
revoke all on public.llm_event_config, public.llm_event_items, public.llm_event_scores from anon, authenticated;

create or replace function public.llm_event_append_only() returns trigger
language plpgsql set search_path = public as $$
begin
  raise exception '% is append-only', tg_table_name;
end $$;

drop trigger if exists llm_event_items_no_change on public.llm_event_items;
create trigger llm_event_items_no_change before update or delete on public.llm_event_items
  for each row execute function public.llm_event_append_only();
drop trigger if exists llm_event_scores_no_change on public.llm_event_scores;
create trigger llm_event_scores_no_change before update or delete on public.llm_event_scores
  for each row execute function public.llm_event_append_only();

-- 13:10 and 13:40 UTC: after the 12:15 / 12:45 UTC news snapshots. Item keys make reruns idempotent.
select cron.schedule('kairos-llm-events-1', '10 13 * * *',
  $$select public.kairos_call_agent('/api/agents/llm-events', '{}'::jsonb, 'POST', 120000)$$);
select cron.schedule('kairos-llm-events-2', '40 13 * * *',
  $$select public.kairos_call_agent('/api/agents/llm-events', '{}'::jsonb, 'POST', 120000)$$);
