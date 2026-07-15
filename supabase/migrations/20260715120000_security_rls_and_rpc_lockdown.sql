-- Security remediation: Supabase Security Advisor flagged (ERROR) 16 public
-- tables with RLS disabled -> readable/writable via the public anon API key, and
-- (WARN) several SECURITY DEFINER RPCs executable by the anon role.
--
-- Fix, without breaking the app:
--   * 15 agent-internal tables (read/written only by server routes via the
--     service_role key, which BYPASSES RLS) -> ENABLE RLS with no policy =
--     deny-all to anon/authenticated. Same pattern as app_settings/api_key_vault
--     (already locked this way; the app works fine through service-role routes).
--   * newsletters IS read by the browser (authenticated) on /dashboard/intelligence
--     -> ENABLE RLS + an authenticated SELECT policy so anon is blocked but the
--     logged-in owner can still read. (Written only by the service-role edge fn.)
--   * REVOKE EXECUTE on anon-callable SECURITY DEFINER functions. service_role is
--     unaffected (it owns/bypasses). get_daily_ai_count is called client-side by
--     the authenticated owner, so only anon is revoked there.
--
-- Reversible: ALTER TABLE ... DISABLE ROW LEVEL SECURITY / re-GRANT restores prior
-- state. Single-owner today, so authenticated == the owner; multi-tenant will
-- tighten these to per-user_id policies.

-- ── 1. Deny-all RLS on server-only agent-internal tables ──────────────────────
alter table public.macro_signals            enable row level security;
alter table public.macro_regime             enable row level security;
alter table public.mentor_dimension_logs    enable row level security;
alter table public.agent_config             enable row level security;
alter table public.learner_config           enable row level security;
alter table public.learning_priors          enable row level security;
alter table public.signal_weights_history   enable row level security;
alter table public.learner_runs             enable row level security;
alter table public.india_screen_cache       enable row level security;
alter table public.observation_labels       enable row level security;
alter table public.shadow_decisions         enable row level security;
alter table public.model_artifacts          enable row level security;
alter table public.feature_registry         enable row level security;
alter table public.validation_experiments   enable row level security;
alter table public.decision_observations    enable row level security;

-- ── 2. newsletters: block anon, allow authenticated (owner) read ──────────────
alter table public.newsletters enable row level security;
drop policy if exists newsletters_authenticated_read on public.newsletters;
create policy newsletters_authenticated_read
  on public.newsletters for select to authenticated using (true);

-- ── 3. Revoke anon/authenticated EXECUTE on SECURITY DEFINER RPCs ─────────────
-- Internal agent invoker + RLS toggler + auth trigger fn: no client caller.
revoke execute on function public.kairos_call_agent(text, jsonb, text, integer) from anon, authenticated;
revoke execute on function public.rls_auto_enable()                            from anon, authenticated;
revoke execute on function public.handle_new_user()                           from anon, authenticated;

-- Evidence-policy RPCs: server (service_role) only; anon must not flip policy.
revoke execute on function public.activate_evidence_policy(text, uuid, text[], uuid) from anon, authenticated;
revoke execute on function public.create_evidence_policy_version(text, jsonb, text, uuid) from anon, authenticated;
revoke execute on function public.claim_provider_refresh_jobs(integer, integer)      from anon, authenticated;

-- get_daily_ai_count IS called by the authenticated owner in the browser
-- (intelligence page) -> revoke from anon ONLY, keep authenticated.
revoke execute on function public.get_daily_ai_count(uuid) from anon;

-- ── 4. Follow-up (applied same session): the REVOKE above from anon/authenticated
-- did NOT bite because these definer fns carry the default GRANT EXECUTE TO PUBLIC
-- which anon inherits. Revoke from PUBLIC, re-grant only real callers. ───────────
revoke execute on function public.kairos_call_agent(text, jsonb, text, integer) from public;
grant  execute on function public.kairos_call_agent(text, jsonb, text, integer) to service_role;
revoke execute on function public.rls_auto_enable() from public;
revoke execute on function public.handle_new_user() from public;
revoke execute on function public.get_daily_ai_count(uuid) from public;
grant  execute on function public.get_daily_ai_count(uuid) to authenticated, service_role;

-- ── 5. Pin mutable search_path on SECURITY DEFINER / trigger-guard functions.
-- (pgvector RPCs match_doc_chunks / match_trade_memories intentionally excluded.) ─
alter function public.av_budget_increment(p_date date) set search_path = public;
alter function public.block_rotation_events_mutation() set search_path = public;
alter function public.boe_block_mutation() set search_path = public;
alter function public.dobs_block_mutation() set search_path = public;
alter function public.evidence_block_mutation() set search_path = public;
alter function public.evidence_records_immutable() set search_path = public;
alter function public.holding_risk_append_only() set search_path = public;
alter function public.holding_risk_runs_lifecycle_guard() set search_path = public;
alter function public.hr_num(p jsonb, k text) set search_path = public;
alter function public.market_trading_day_start(p_market text) set search_path = public;
alter function public.paper_order_events_immutable() set search_path = public;
alter function public.provider_budget_increment(p_provider text, p_date date) set search_path = public;
alter function public.se_no_update() set search_path = public;
alter function public.set_initial_stop_loss() set search_path = public;
alter function public.try_acquire_provider_slot(p_provider text, p_min_interval_ms integer) set search_path = public;

-- ── 6. Tighten 7 always-true RLS policies. The `service_all` ones targeted PUBLIC
-- (FOR ALL USING/CHECK true) -> anon had full read+WRITE on these tables. Replace
-- each with an authenticated SELECT-only policy: anon loses all access, owner keeps
-- read, service_role writes via bypass. No browser client reads these (verified). ─
drop policy if exists service_all on public.agent_alerts;
create policy agent_alerts_auth_read on public.agent_alerts for select to authenticated using (true);
drop policy if exists authenticated_only on public.agent_runs;
create policy agent_runs_auth_read on public.agent_runs for select to authenticated using (true);
drop policy if exists service_all on public.briefings;
create policy briefings_auth_read on public.briefings for select to authenticated using (true);
drop policy if exists service_all on public.earnings_calendar;
create policy earnings_calendar_auth_read on public.earnings_calendar for select to authenticated using (true);
drop policy if exists service_all on public.llm_call_log;
create policy llm_call_log_auth_read on public.llm_call_log for select to authenticated using (true);
drop policy if exists service_all on public.strategy_classifications;
create policy strategy_classifications_auth_read on public.strategy_classifications for select to authenticated using (true);
drop policy if exists service_all on public.strategy_templates;
create policy strategy_templates_auth_read on public.strategy_templates for select to authenticated using (true);

-- ── 7. The two pgvector RPCs need `extensions` on the path (vector <=> operator). ─
alter function public.match_doc_chunks(vector, integer, text, text) set search_path = public, extensions;
alter function public.match_trade_memories(vector, integer, text) set search_path = public, extensions;
