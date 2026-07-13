-- 172: research carry-forward queue.
--
-- WHY: gatherSymbols caps candidates per run (RESEARCH_CANDIDATE_CAP) and used
-- `.slice(0, cap)` — candidates beyond the cap were SILENTLY DROPPED. Fine at
-- ~30 symbols/run, but as the watchlist/screener pool grows toward the provider
-- ceiling (~120 symbols/day before FMP's 240 budget binds), overflow candidates
-- must not vanish — they carry forward and get HIGHER priority next run so
-- coverage rotates fairly and starvation is impossible.
--
-- One row per (market, symbol) that missed a run's cut. `priority` and `attempts`
-- increment each time it keeps missing, so a persistently-deferred symbol
-- eventually wins a slot. Rows are deleted once the symbol makes it into a batch.

create table if not exists public.research_queue (
  market           text not null check (market in ('us', 'india')),
  symbol           text not null,
  priority         int  not null default 1,
  attempts         int  not null default 1,
  discovery_source text,
  deferred_at      timestamptz not null default now(),
  primary key (market, symbol)
);

create index if not exists research_queue_market_priority_idx
  on public.research_queue (market, priority desc, deferred_at asc);

alter table public.research_queue enable row level security;
-- Service-role writes/reads (the research agent). Owner may read for a dashboard.
drop policy if exists research_queue_owner_read on public.research_queue;
create policy research_queue_owner_read
  on public.research_queue for select to authenticated
  using ((auth.jwt() ->> 'email') = 'vterminater@gmail.com');
