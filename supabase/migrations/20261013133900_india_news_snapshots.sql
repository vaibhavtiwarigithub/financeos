-- Append-only, dated snapshots of the India news/event shadow so a point-in-time
-- history exists. evidence_cache_v2 upserts one row per symbol and overwrites the
-- previous run, which makes forward-return evaluation of any news-derived
-- feature impossible. Shadow data only: nothing in scoring reads this table.

create table if not exists public.india_news_snapshots (
  id bigint generated always as identity primary key,
  symbol text not null,
  source text not null check (source in ('google_news_rss', 'nse_corporate_announcements')),
  run_id text not null,
  fetched_at timestamptz not null default now(),
  item_count int not null default 0,
  payload jsonb not null,
  payload_hash text not null,
  unique (symbol, source, run_id)
);

create index if not exists india_news_snapshots_symbol_fetched_idx
  on public.india_news_snapshots (symbol, fetched_at desc);

alter table public.india_news_snapshots enable row level security;
revoke all on public.india_news_snapshots from anon, authenticated;

create or replace function public.india_news_snapshots_append_only() returns trigger
language plpgsql as $$
begin
  raise exception 'india_news_snapshots is append-only';
end $$;

drop trigger if exists india_news_snapshots_no_change on public.india_news_snapshots;
create trigger india_news_snapshots_no_change
  before update or delete on public.india_news_snapshots
  for each row execute function public.india_news_snapshots_append_only();

-- Second daily pass so the whole India universe is covered: each run handles the
-- stalest symbols first within a time budget, 12:15 UTC = 17:45 IST.
select cron.schedule(
  'kairos-india-news-shadow-2',
  '45 12 * * *',
  $$select public.kairos_call_agent('/api/agents/india-news-shadow', '{}'::jsonb, 'POST', 60000)$$
);
