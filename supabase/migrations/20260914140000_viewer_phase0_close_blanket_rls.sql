-- Shared Viewer Access — Phase 0: close blanket-authenticated RLS policies.
--
-- features/shared-viewer-access/FEATURE_ARCHITECTURE.md, Phase 0. Owner-approved
-- 2026-09-14. NO viewer role, allowlist, or invitation ships here — this migration
-- only narrows what an authenticated session can reach directly.
--
-- WHY. Dashboard pages are server-rendered through createServiceClient(), and
-- service_role has rolbypassrls=true (verified in production), so NONE of the 266
-- service-role call sites are affected by these policies. But
-- lib/supabase/client.ts ships NEXT_PUBLIC_SUPABASE_ANON_KEY to the browser, so
-- any holder of a valid session can query PostgREST directly. These 34 tables
-- were readable — and 7 of them WRITABLE — by any authenticated user, including
-- the paper book, the learner's weights, and live position state. Today only the
-- owner can obtain a session, so this is not a live breach; it is a control with
-- one user's margin, which the viewer feature would spend.
--
-- WHAT. Every policy below is replaced by the repository's canonical owner-pinned
-- read policy (the form already used by 39 tables):
--   FOR SELECT TO authenticated
--   USING (((SELECT auth.jwt()) ->> 'email') = 'vterminater@gmail.com')
--
-- Writes are NOT re-granted: the seven FOR ALL policies become SELECT-only.
-- Nothing in the app writes these tables from the browser; all writes are
-- service-role and bypass RLS.
--
-- NOTE. Five policies below are already NAMED "<table>_owner_read" but their
-- USING clause is literally `true` — the name claimed a scoping the predicate
-- never implemented (agentic_position_ledger, live_exit_ladder_shadow,
-- live_position_state, readiness_controls, readiness_runs).
--
-- OWNER IMPACT: none expected. The only browser-side Supabase queries are in
-- DashboardShell (strategy_config, trade_proposals), intelligence (newsletters,
-- profiles) and settings (profiles, strategy_versions). Of those, only
-- `newsletters` is in this set, and it is re-created owner-pinned so the owner
-- keeps access. `profiles` is auth.uid()-scoped and untouched.
--
-- ROLLBACK: restore the prior policy per table, e.g.
--   drop policy if exists "<table>_owner_read" on public.<table>;
--   create policy "<old_name>" on public.<table> for select to authenticated using (true);
-- (the seven FOR ALL tables used: for all to public using (auth.role() = 'authenticated')).


drop policy if exists "agent_alerts_auth_read" on public.agent_alerts;
drop policy if exists "agent_alerts_owner_read" on public.agent_alerts;
create policy "agent_alerts_owner_read" on public.agent_alerts
  for select to authenticated
  using (((select auth.jwt()) ->> 'email'::text) = 'vterminater@gmail.com'::text);

drop policy if exists "auth_read_agent_memory" on public.agent_memory;
drop policy if exists "agent_memory_owner_read" on public.agent_memory;
create policy "agent_memory_owner_read" on public.agent_memory
  for select to authenticated
  using (((select auth.jwt()) ->> 'email'::text) = 'vterminater@gmail.com'::text);

drop policy if exists "agent_runs_auth_read" on public.agent_runs;
drop policy if exists "agent_runs_owner_read" on public.agent_runs;
create policy "agent_runs_owner_read" on public.agent_runs
  for select to authenticated
  using (((select auth.jwt()) ->> 'email'::text) = 'vterminater@gmail.com'::text);

drop policy if exists "authenticated_only" on public.agent_signals;
drop policy if exists "agent_signals_owner_read" on public.agent_signals;
create policy "agent_signals_owner_read" on public.agent_signals
  for select to authenticated
  using (((select auth.jwt()) ->> 'email'::text) = 'vterminater@gmail.com'::text);

drop policy if exists "agentic_position_ledger_owner_read" on public.agentic_position_ledger;
create policy "agentic_position_ledger_owner_read" on public.agentic_position_ledger
  for select to authenticated
  using (((select auth.jwt()) ->> 'email'::text) = 'vterminater@gmail.com'::text);

drop policy if exists "Anyone reads announcements" on public.announcements;
drop policy if exists "announcements_owner_read" on public.announcements;
create policy "announcements_owner_read" on public.announcements
  for select to authenticated
  using (((select auth.jwt()) ->> 'email'::text) = 'vterminater@gmail.com'::text);

drop policy if exists "briefings_auth_read" on public.briefings;
drop policy if exists "briefings_owner_read" on public.briefings;
create policy "briefings_owner_read" on public.briefings
  for select to authenticated
  using (((select auth.jwt()) ->> 'email'::text) = 'vterminater@gmail.com'::text);

drop policy if exists "earnings_calendar_auth_read" on public.earnings_calendar;
drop policy if exists "earnings_calendar_owner_read" on public.earnings_calendar;
create policy "earnings_calendar_owner_read" on public.earnings_calendar
  for select to authenticated
  using (((select auth.jwt()) ->> 'email'::text) = 'vterminater@gmail.com'::text);

drop policy if exists "earnings_consensus_snapshots_authenticated_read" on public.earnings_consensus_snapshots;
drop policy if exists "earnings_consensus_snapshots_owner_read" on public.earnings_consensus_snapshots;
create policy "earnings_consensus_snapshots_owner_read" on public.earnings_consensus_snapshots
  for select to authenticated
  using (((select auth.jwt()) ->> 'email'::text) = 'vterminater@gmail.com'::text);

drop policy if exists "india_market_snapshot_authenticated_read" on public.india_market_snapshot;
drop policy if exists "india_market_snapshot_owner_read" on public.india_market_snapshot;
create policy "india_market_snapshot_owner_read" on public.india_market_snapshot
  for select to authenticated
  using (((select auth.jwt()) ->> 'email'::text) = 'vterminater@gmail.com'::text);

drop policy if exists "instrument_family_observations_authenticated_read" on public.instrument_family_observations;
drop policy if exists "instrument_family_observations_owner_read" on public.instrument_family_observations;
create policy "instrument_family_observations_owner_read" on public.instrument_family_observations
  for select to authenticated
  using (((select auth.jwt()) ->> 'email'::text) = 'vterminater@gmail.com'::text);

drop policy if exists "authenticated_only" on public.learning_log;
drop policy if exists "learning_log_owner_read" on public.learning_log;
create policy "learning_log_owner_read" on public.learning_log
  for select to authenticated
  using (((select auth.jwt()) ->> 'email'::text) = 'vterminater@gmail.com'::text);

drop policy if exists "live_exit_ladder_shadow_owner_read" on public.live_exit_ladder_shadow;
create policy "live_exit_ladder_shadow_owner_read" on public.live_exit_ladder_shadow
  for select to authenticated
  using (((select auth.jwt()) ->> 'email'::text) = 'vterminater@gmail.com'::text);

drop policy if exists "live_position_state_owner_read" on public.live_position_state;
create policy "live_position_state_owner_read" on public.live_position_state
  for select to authenticated
  using (((select auth.jwt()) ->> 'email'::text) = 'vterminater@gmail.com'::text);

drop policy if exists "llm_call_log_auth_read" on public.llm_call_log;
drop policy if exists "llm_call_log_owner_read" on public.llm_call_log;
create policy "llm_call_log_owner_read" on public.llm_call_log
  for select to authenticated
  using (((select auth.jwt()) ->> 'email'::text) = 'vterminater@gmail.com'::text);

drop policy if exists "newsletters_authenticated_read" on public.newsletters;
drop policy if exists "newsletters_owner_read" on public.newsletters;
create policy "newsletters_owner_read" on public.newsletters
  for select to authenticated
  using (((select auth.jwt()) ->> 'email'::text) = 'vterminater@gmail.com'::text);

drop policy if exists "auth_read_paper_nav_history" on public.paper_nav_history;
drop policy if exists "paper_nav_history_owner_read" on public.paper_nav_history;
create policy "paper_nav_history_owner_read" on public.paper_nav_history
  for select to authenticated
  using (((select auth.jwt()) ->> 'email'::text) = 'vterminater@gmail.com'::text);

drop policy if exists "authenticated_only" on public.paper_performance;
drop policy if exists "paper_performance_owner_read" on public.paper_performance;
create policy "paper_performance_owner_read" on public.paper_performance
  for select to authenticated
  using (((select auth.jwt()) ->> 'email'::text) = 'vterminater@gmail.com'::text);

drop policy if exists "authenticated_only" on public.paper_portfolio;
drop policy if exists "paper_portfolio_owner_read" on public.paper_portfolio;
create policy "paper_portfolio_owner_read" on public.paper_portfolio
  for select to authenticated
  using (((select auth.jwt()) ->> 'email'::text) = 'vterminater@gmail.com'::text);

drop policy if exists "authenticated_only" on public.paper_positions;
drop policy if exists "paper_positions_owner_read" on public.paper_positions;
create policy "paper_positions_owner_read" on public.paper_positions
  for select to authenticated
  using (((select auth.jwt()) ->> 'email'::text) = 'vterminater@gmail.com'::text);

drop policy if exists "auth_read_price_cache" on public.price_cache;
drop policy if exists "price_cache_owner_read" on public.price_cache;
create policy "price_cache_owner_read" on public.price_cache
  for select to authenticated
  using (((select auth.jwt()) ->> 'email'::text) = 'vterminater@gmail.com'::text);

drop policy if exists "readiness_controls_owner_read" on public.readiness_controls;
create policy "readiness_controls_owner_read" on public.readiness_controls
  for select to authenticated
  using (((select auth.jwt()) ->> 'email'::text) = 'vterminater@gmail.com'::text);

drop policy if exists "readiness_runs_owner_read" on public.readiness_runs;
create policy "readiness_runs_owner_read" on public.readiness_runs
  for select to authenticated
  using (((select auth.jwt()) ->> 'email'::text) = 'vterminater@gmail.com'::text);

drop policy if exists "authenticated_only" on public.research_packets;
drop policy if exists "research_packets_owner_read" on public.research_packets;
create policy "research_packets_owner_read" on public.research_packets
  for select to authenticated
  using (((select auth.jwt()) ->> 'email'::text) = 'vterminater@gmail.com'::text);

drop policy if exists "auth_read_risk_analytics_cache" on public.risk_analytics_cache;
drop policy if exists "risk_analytics_cache_owner_read" on public.risk_analytics_cache;
create policy "risk_analytics_cache_owner_read" on public.risk_analytics_cache
  for select to authenticated
  using (((select auth.jwt()) ->> 'email'::text) = 'vterminater@gmail.com'::text);

drop policy if exists "auth_read_sector_breadth_history" on public.sector_breadth_history;
drop policy if exists "sector_breadth_history_owner_read" on public.sector_breadth_history;
create policy "sector_breadth_history_owner_read" on public.sector_breadth_history
  for select to authenticated
  using (((select auth.jwt()) ->> 'email'::text) = 'vterminater@gmail.com'::text);

drop policy if exists "authenticated_read" on public.security_events;
drop policy if exists "security_events_owner_read" on public.security_events;
create policy "security_events_owner_read" on public.security_events
  for select to authenticated
  using (((select auth.jwt()) ->> 'email'::text) = 'vterminater@gmail.com'::text);

drop policy if exists "authenticated_read_signal_score_history" on public.signal_score_history;
drop policy if exists "signal_score_history_owner_read" on public.signal_score_history;
create policy "signal_score_history_owner_read" on public.signal_score_history
  for select to authenticated
  using (((select auth.jwt()) ->> 'email'::text) = 'vterminater@gmail.com'::text);

drop policy if exists "authenticated_only" on public.signal_weights;
drop policy if exists "signal_weights_owner_read" on public.signal_weights;
create policy "signal_weights_owner_read" on public.signal_weights
  for select to authenticated
  using (((select auth.jwt()) ->> 'email'::text) = 'vterminater@gmail.com'::text);

drop policy if exists "strategy_classifications_auth_read" on public.strategy_classifications;
drop policy if exists "strategy_classifications_owner_read" on public.strategy_classifications;
create policy "strategy_classifications_owner_read" on public.strategy_classifications
  for select to authenticated
  using (((select auth.jwt()) ->> 'email'::text) = 'vterminater@gmail.com'::text);

drop policy if exists "strategy_templates_auth_read" on public.strategy_templates;
drop policy if exists "strategy_templates_owner_read" on public.strategy_templates;
create policy "strategy_templates_owner_read" on public.strategy_templates
  for select to authenticated
  using (((select auth.jwt()) ->> 'email'::text) = 'vterminater@gmail.com'::text);

drop policy if exists "symbol_profiles_authenticated_read" on public.symbol_profiles;
drop policy if exists "symbol_profiles_owner_read" on public.symbol_profiles;
create policy "symbol_profiles_owner_read" on public.symbol_profiles
  for select to authenticated
  using (((select auth.jwt()) ->> 'email'::text) = 'vterminater@gmail.com'::text);

drop policy if exists "auth_read_trade_log" on public.trade_log;
drop policy if exists "trade_log_owner_read" on public.trade_log;
create policy "trade_log_owner_read" on public.trade_log
  for select to authenticated
  using (((select auth.jwt()) ->> 'email'::text) = 'vterminater@gmail.com'::text);

drop policy if exists "auth_read_trade_queue" on public.trade_queue;
drop policy if exists "trade_queue_owner_read" on public.trade_queue;
create policy "trade_queue_owner_read" on public.trade_queue
  for select to authenticated
  using (((select auth.jwt()) ->> 'email'::text) = 'vterminater@gmail.com'::text);
