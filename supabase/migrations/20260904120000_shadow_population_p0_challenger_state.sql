-- Shadow-population P0 (features/shadow-population/FEATURE_ARCHITECTURE.md).
--
-- THE BUG THIS FIXES. LearnerAgent has always written strategy_versions rows with
-- state = 'challenger' (app/api/agents/learner/route.ts) and the Friday validation
-- sweep has always queried .eq("state", "challenger") (app/api/validation/sweep/route.ts).
-- Neither ever worked: 'challenger' was never in strategy_versions_state_check's
-- allowed list, so every insert failed at the database layer. Confirmed in production
-- 2026-09-04: strategy_versions has exactly 2 rows (the two market champions, both
-- paper_active), validation_experiments has 0 rows, and zero strategy_versions row has
-- ever held state='challenger' or 'shadow_paper'. The whole champion/challenger
-- validation pipeline has never actually run once.
--
-- Adding the value does not retroactively create any row or change any existing one.

alter table public.strategy_versions drop constraint if exists strategy_versions_state_check;
alter table public.strategy_versions add constraint strategy_versions_state_check
  check (state = any (array[
    'draft', 'testing', 'rejected', 'paper_candidate', 'paper_active', 'paper_paused',
    'eligible', 'approved_live', 'live_paused', 'retired', 'shadow_paper', 'measure_only',
    'live_review_eligible', 'live_approved',
    'challenger'
  ]));

-- THE SECOND GAP. sv_champion_idx (`is_champion) where is_champion = true`) is NOT
-- unique and is not scoped by market — it speeds up the "find the champion" read but
-- does nothing to stop two rows in the SAME market both holding is_champion=true. Only
-- the advisory lock inside the atomic promotion RPC (161_atomic_strategy_promotion.sql)
-- protects the one path that goes through it; a direct service_role UPDATE (or a bug in
-- a future RPC) is not stopped by anything in the schema itself. Verified clean before
-- adding this: production holds exactly one is_champion=true row per market (id 1 = us,
-- id 4 = india), so this constraint applies with zero pre-existing conflict.
create unique index if not exists strategy_versions_one_champion_per_market
  on public.strategy_versions (market)
  where is_champion = true;
