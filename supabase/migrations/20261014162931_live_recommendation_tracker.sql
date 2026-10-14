-- Live recommendation tracker + Guardian scorecard (measure/display only). Records every recommendation shown for the live Robinhood book
-- (BUY ideas, Guardian stop suggestions, exit signals), detects from daily holdings whether it was acted on, and marks how it fared against the
-- symbol and SPY. No order, stop or Guardian setting is read from or written by these tables.

create table if not exists public.live_recommendations (
  id bigint generated always as identity primary key,
  dedup_key text not null unique,
  kind text not null check (kind in ('buy_idea', 'guardian_stop', 'exit_signal')),
  account_id text not null,
  symbol text not null,
  issued_at timestamptz not null,
  reference_price numeric,
  level_price numeric,
  qty_suggested numeric,
  horizon_sessions int not null default 10,
  source_table text not null,
  source_id text not null,
  rationale text,
  created_at timestamptz not null default now()
);
create index if not exists live_recommendations_issued_idx on public.live_recommendations (issued_at desc);

create table if not exists public.live_recommendation_marks (
  id bigint generated always as identity primary key,
  rec_id bigint not null references public.live_recommendations (id),
  marked_on date not null,
  status text not null check (status in ('pending', 'taken', 'expired_unanswered', 'not_taken', 'followed', 'ignored', 'watching')),
  response_account text,
  response_detail text,
  sessions_since int not null,
  last_price numeric,
  symbol_return_pct numeric,
  benchmark_return_pct numeric,
  excess_pct numeric,
  pnl_pct numeric,
  pnl_basis text check (pnl_basis in ('actual', 'hypothetical')),
  level_touched boolean,
  level_touched_on date,
  pnl_if_level_pct numeric,
  created_at timestamptz not null default now(),
  unique (rec_id, marked_on)
);
create index if not exists live_recommendation_marks_idx on public.live_recommendation_marks (marked_on desc, rec_id);

create table if not exists public.live_guardian_revisions (
  id bigint generated always as identity primary key,
  revised_on date not null unique,
  sample int not null,
  distinct_symbols int not null,
  arms jsonb not null,
  note text not null,
  created_at timestamptz not null default now()
);

alter table public.live_recommendations enable row level security;
alter table public.live_recommendation_marks enable row level security;
alter table public.live_guardian_revisions enable row level security;
revoke all on public.live_recommendations, public.live_recommendation_marks, public.live_guardian_revisions from anon, authenticated;

drop trigger if exists live_recommendations_no_change on public.live_recommendations;
create trigger live_recommendations_no_change before update or delete on public.live_recommendations for each row execute function public.llm_event_append_only();
drop trigger if exists live_recommendation_marks_no_change on public.live_recommendation_marks;
create trigger live_recommendation_marks_no_change before update or delete on public.live_recommendation_marks for each row execute function public.llm_event_append_only();
drop trigger if exists live_guardian_revisions_no_change on public.live_guardian_revisions;
create trigger live_guardian_revisions_no_change before update or delete on public.live_guardian_revisions for each row execute function public.llm_event_append_only();

-- 22:30 UTC daily, after US close and the price cache refresh.
select cron.schedule('kairos-live-recommendations', '30 22 * * *',
  $$select public.kairos_call_agent('/api/agents/live-recommendations', '{}'::jsonb, 'POST', 120000)$$);
