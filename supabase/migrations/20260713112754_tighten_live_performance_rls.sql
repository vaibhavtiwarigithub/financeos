-- Tighten live_performance RLS to owner-only reads.
--
-- Migration 169 used auth.role()='authenticated', which lets any authenticated
-- Supabase user read every live account equity curve. Kairos is single-owner;
-- match market_controls/research_queue/strategy_sleeves owner-email RLS.

alter table public.live_performance enable row level security;

drop policy if exists live_performance_authenticated_read on public.live_performance;
drop policy if exists live_performance_owner_read on public.live_performance;

create policy live_performance_owner_read
  on public.live_performance
  for select
  to authenticated
  using (((select auth.jwt()) ->> 'email') = 'vterminater@gmail.com');
