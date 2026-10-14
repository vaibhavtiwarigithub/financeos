-- India index-ETF sleeve SHADOW (measure-only): the NAV the India paper book would have had with a fixed share of capital in NIFTYBEES,
-- daily-rebalanced. No orders, no capital moved; nothing in trading reads it. Append-only; one row per session per weight per method.

create table if not exists public.india_sleeve_shadow_nav (
  id bigint generated always as identity primary key,
  as_of_date date not null,
  weight numeric not null check (weight > 0 and weight < 1),
  method text not null,
  blended_nav numeric not null,
  book_nav numeric not null,
  etf_close numeric not null,
  computed_at timestamptz not null default now(),
  run_id text not null,
  unique (as_of_date, weight, method)
);
create index if not exists india_sleeve_shadow_nav_idx on public.india_sleeve_shadow_nav (method, weight, as_of_date desc);

alter table public.india_sleeve_shadow_nav enable row level security;
revoke all on public.india_sleeve_shadow_nav from anon, authenticated;

drop trigger if exists india_sleeve_shadow_nav_no_change on public.india_sleeve_shadow_nav;
create trigger india_sleeve_shadow_nav_no_change before update or delete on public.india_sleeve_shadow_nav
  for each row execute function public.llm_event_append_only();

-- 13:20 UTC daily: after the 11:15 UTC India EOD monitor (book NAV) and the 13:00 UTC macro-series collector (NIFTYBEES close).
select cron.schedule('kairos-india-sleeve-shadow', '20 13 * * *',
  $$select public.kairos_call_agent('/api/agents/india-index-sleeve-shadow', '{}'::jsonb, 'POST', 60000)$$);
