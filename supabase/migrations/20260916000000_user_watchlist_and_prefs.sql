-- User watchlist: per-user saved symbols for risk + research tracking.
-- Per-user broker risk phase follow-on: users add symbols to watch, the app
-- shows last research date, last score, and links to Deep Dive.
create table if not exists public.user_watchlist (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references auth.users(id) on delete cascade,
  symbol     text not null,
  market     text not null check (market in ('us','india')),
  added_at   timestamptz not null default now(),
  unique (user_id, symbol, market)
);

create index if not exists user_watchlist_user_idx
  on public.user_watchlist (user_id, added_at desc);

alter table public.user_watchlist enable row level security;

drop policy if exists "user_watchlist_self" on public.user_watchlist;
create policy "user_watchlist_self" on public.user_watchlist
  for all to authenticated using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));

-- User notification prefs: email digest + newsletter opt-in.
-- The risk email has its own table (user_risk_email_prefs). This adds a
-- newsletter opt-in field without altering that table's tight contract.
create table if not exists public.user_notification_prefs (
  user_id          uuid primary key references auth.users(id) on delete cascade,
  newsletter_opted_in boolean not null default false,
  updated_at       timestamptz not null default now()
);

alter table public.user_notification_prefs enable row level security;

drop policy if exists "user_notification_prefs_self" on public.user_notification_prefs;
create policy "user_notification_prefs_self" on public.user_notification_prefs
  for all to authenticated using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));
