-- FinanceOS Complete Schema
-- Run this in Supabase SQL editor

-- Enable required extensions
create extension if not exists "uuid-ossp";

-- ─────────────────────────────────────────────
-- PROFILES (extends Supabase auth.users)
-- ─────────────────────────────────────────────
create table public.profiles (
  id uuid references auth.users(id) on delete cascade primary key,
  email text not null,
  full_name text,
  avatar_url text,
  role text not null default 'user' check (role in ('user', 'admin', 'superadmin')),
  subscription_tier text not null default 'free' check (subscription_tier in ('free', 'pro', 'elite')),
  subscription_status text not null default 'active' check (subscription_status in ('active', 'canceled', 'past_due', 'trialing')),
  stripe_customer_id text unique,
  stripe_subscription_id text unique,
  subscription_ends_at timestamptz,
  -- User preferences
  market_focus text default 'Both' check (market_focus in ('US', 'India', 'Both')),
  knowledge_level text default 'Intermediate' check (knowledge_level in ('Beginner', 'Intermediate', 'Advanced')),
  theme text default 'dark' check (theme in ('dark', 'light', 'midnight')),
  ai_model text default 'claude-sonnet',
  -- Gamification
  xp integer default 0,
  streak_days integer default 0,
  last_active_date date,
  analysis_count integer default 0,
  -- DNA scores (financial knowledge areas)
  dna_macro integer default 50,
  dna_equities integer default 50,
  dna_fixed_income integer default 40,
  dna_derivatives integer default 30,
  dna_risk_mgmt integer default 50,
  dna_behavioral integer default 45,
  dna_technical integer default 55,
  dna_crypto integer default 35,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

-- Auto-create profile on signup
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  user_role text := 'user';
begin
  -- Check if this email should be superadmin
  if new.email = 'vterminater@gmail.com' then
    user_role := 'superadmin';
  end if;
  
  insert into public.profiles (id, email, full_name, avatar_url, role)
  values (
    new.id,
    new.email,
    coalesce(new.raw_user_meta_data->>'full_name', new.raw_user_meta_data->>'name'),
    new.raw_user_meta_data->>'avatar_url',
    user_role
  );
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute procedure public.handle_new_user();

-- Updated_at trigger
create or replace function public.handle_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create trigger profiles_updated_at before update on public.profiles
  for each row execute procedure public.handle_updated_at();

-- ─────────────────────────────────────────────
-- HOLDINGS (portfolio)
-- ─────────────────────────────────────────────
create table public.holdings (
  id uuid default uuid_generate_v4() primary key,
  user_id uuid references public.profiles(id) on delete cascade not null,
  symbol text not null,
  name text not null,
  qty numeric not null,
  avg_cost numeric not null,
  current_price numeric not null,
  sector text default 'Other',
  exchange text default 'US' check (exchange in ('US', 'NSE', 'BSE', 'Crypto', 'Other')),
  notes text,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create trigger holdings_updated_at before update on public.holdings
  for each row execute procedure public.handle_updated_at();

-- ─────────────────────────────────────────────
-- PREDICTIONS
-- ─────────────────────────────────────────────
create table public.predictions (
  id uuid default uuid_generate_v4() primary key,
  user_id uuid references public.profiles(id) on delete cascade not null,
  asset text not null,
  thesis text not null,
  direction text not null check (direction in ('UP', 'DOWN', 'SIDEWAYS')),
  target_price numeric,
  timeframe text not null,
  confidence integer check (confidence >= 0 and confidence <= 100),
  status text not null default 'open' check (status in ('open', 'correct', 'incorrect', 'partial', 'expired')),
  score integer check (score >= 0 and score <= 10),
  actual_outcome text,
  resolved_at timestamptz,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create trigger predictions_updated_at before update on public.predictions
  for each row execute procedure public.handle_updated_at();

-- ─────────────────────────────────────────────
-- TRADE JOURNAL
-- ─────────────────────────────────────────────
create table public.journal_entries (
  id uuid default uuid_generate_v4() primary key,
  user_id uuid references public.profiles(id) on delete cascade not null,
  asset text not null,
  direction text not null check (direction in ('LONG', 'SHORT')),
  entry_price numeric,
  exit_price numeric,
  pnl numeric,
  setup text,
  emotion text default 'Neutral',
  lesson text,
  tags text[],
  created_at timestamptz default now()
);

-- ─────────────────────────────────────────────
-- QUIZ HISTORY
-- ─────────────────────────────────────────────
create table public.quiz_history (
  id uuid default uuid_generate_v4() primary key,
  user_id uuid references public.profiles(id) on delete cascade not null,
  domain text not null,
  question text not null,
  correct boolean not null,
  xp_earned integer default 0,
  created_at timestamptz default now()
);

-- ─────────────────────────────────────────────
-- AI BRIEF HISTORY
-- ─────────────────────────────────────────────
create table public.brief_history (
  id uuid default uuid_generate_v4() primary key,
  user_id uuid references public.profiles(id) on delete cascade not null,
  content text not null,
  model_used text,
  tokens_used integer,
  created_at timestamptz default now()
);

-- ─────────────────────────────────────────────
-- READING LIST
-- ─────────────────────────────────────────────
create table public.reading_list (
  id uuid default uuid_generate_v4() primary key,
  user_id uuid references public.profiles(id) on delete cascade not null,
  title text not null,
  url text,
  domain text,
  notes text,
  completed boolean default false,
  created_at timestamptz default now()
);

-- ─────────────────────────────────────────────
-- WATCHLIST (custom tickers)
-- ─────────────────────────────────────────────
create table public.watchlist (
  id uuid default uuid_generate_v4() primary key,
  user_id uuid references public.profiles(id) on delete cascade not null,
  symbol text not null,
  name text,
  market text default 'US' check (market in ('US', 'India', 'Global', 'Crypto')),
  entry_price numeric,
  stop_price numeric,
  notes text,
  created_at timestamptz default now(),
  unique(user_id, symbol)
);

-- ─────────────────────────────────────────────
-- USAGE TRACKING (for rate limiting)
-- ─────────────────────────────────────────────
create table public.usage_logs (
  id uuid default uuid_generate_v4() primary key,
  user_id uuid references public.profiles(id) on delete cascade not null,
  action text not null check (action in ('ai_query', 'brief', 'newsletter', 'stress_test', 'analysis')),
  tokens_used integer default 0,
  cost_usd numeric default 0,
  created_at timestamptz default now()
);

-- Daily usage count view
create or replace view public.daily_usage as
select
  user_id,
  action,
  count(*) as count,
  date(created_at) as usage_date
from public.usage_logs
where date(created_at) = current_date
group by user_id, action, date(created_at);

-- ─────────────────────────────────────────────
-- ADMIN: ANNOUNCEMENT / NOTIFICATIONS
-- ─────────────────────────────────────────────
create table public.announcements (
  id uuid default uuid_generate_v4() primary key,
  title text not null,
  content text not null,
  target_tier text default 'all' check (target_tier in ('all', 'free', 'pro', 'elite')),
  active boolean default true,
  created_by uuid references public.profiles(id),
  created_at timestamptz default now()
);

-- ─────────────────────────────────────────────
-- ROW LEVEL SECURITY
-- ─────────────────────────────────────────────
alter table public.profiles enable row level security;
alter table public.holdings enable row level security;
alter table public.predictions enable row level security;
alter table public.journal_entries enable row level security;
alter table public.quiz_history enable row level security;
alter table public.brief_history enable row level security;
alter table public.reading_list enable row level security;
alter table public.watchlist enable row level security;
alter table public.usage_logs enable row level security;
alter table public.announcements enable row level security;

-- Profiles: users see own, admins see all
create policy "Users can view own profile" on public.profiles for select using (auth.uid() = id);
create policy "Users can update own profile" on public.profiles for update using (auth.uid() = id);
create policy "Admins can view all profiles" on public.profiles for select using (
  exists (select 1 from public.profiles where id = auth.uid() and role in ('admin', 'superadmin'))
);

-- Generic own-data policies
create policy "own_select" on public.holdings for select using (auth.uid() = user_id);
create policy "own_insert" on public.holdings for insert with check (auth.uid() = user_id);
create policy "own_update" on public.holdings for update using (auth.uid() = user_id);
create policy "own_delete" on public.holdings for delete using (auth.uid() = user_id);

create policy "own_select" on public.predictions for select using (auth.uid() = user_id);
create policy "own_insert" on public.predictions for insert with check (auth.uid() = user_id);
create policy "own_update" on public.predictions for update using (auth.uid() = user_id);
create policy "own_delete" on public.predictions for delete using (auth.uid() = user_id);

create policy "own_select" on public.journal_entries for select using (auth.uid() = user_id);
create policy "own_insert" on public.journal_entries for insert with check (auth.uid() = user_id);
create policy "own_delete" on public.journal_entries for delete using (auth.uid() = user_id);

create policy "own_select" on public.quiz_history for select using (auth.uid() = user_id);
create policy "own_insert" on public.quiz_history for insert with check (auth.uid() = user_id);

create policy "own_select" on public.brief_history for select using (auth.uid() = user_id);
create policy "own_insert" on public.brief_history for insert with check (auth.uid() = user_id);

create policy "own_select" on public.reading_list for select using (auth.uid() = user_id);
create policy "own_insert" on public.reading_list for insert with check (auth.uid() = user_id);
create policy "own_update" on public.reading_list for update using (auth.uid() = user_id);
create policy "own_delete" on public.reading_list for delete using (auth.uid() = user_id);

create policy "own_select" on public.watchlist for select using (auth.uid() = user_id);
create policy "own_insert" on public.watchlist for insert with check (auth.uid() = user_id);
create policy "own_update" on public.watchlist for update using (auth.uid() = user_id);
create policy "own_delete" on public.watchlist for delete using (auth.uid() = user_id);

create policy "own_select" on public.usage_logs for select using (auth.uid() = user_id);
create policy "own_insert" on public.usage_logs for insert with check (auth.uid() = user_id);

-- Announcements: anyone can read active ones
create policy "Anyone can read announcements" on public.announcements for select using (active = true);
create policy "Admins can manage announcements" on public.announcements for all using (
  exists (select 1 from public.profiles where id = auth.uid() and role in ('admin', 'superadmin'))
);

-- ─────────────────────────────────────────────
-- HELPER FUNCTIONS
-- ─────────────────────────────────────────────

-- Check user's daily AI usage count
create or replace function public.get_daily_ai_count(p_user_id uuid)
returns integer language sql security definer as $$
  select count(*)::integer
  from public.usage_logs
  where user_id = p_user_id
    and action = 'ai_query'
    and date(created_at) = current_date;
$$;

-- Get AI limit by tier
create or replace function public.get_ai_limit(p_tier text)
returns integer language sql immutable as $$
  select case p_tier
    when 'free' then 5
    when 'pro' then 50
    when 'elite' then 9999
    else 5
  end;
$$;
