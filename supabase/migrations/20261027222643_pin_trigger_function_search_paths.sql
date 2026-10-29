-- Prevent schema-shadowing through mutable search_path on trigger functions.
-- All referenced application objects are already explicitly in public; this
-- changes name resolution order only and leaves bodies/grants unchanged.
do $$
begin
  -- These two helpers exist in production but have no tracked create
  -- migration. Fresh installs have no function to harden, so skip only when
  -- absent; existing installations still receive the search_path fix.
  if to_regprocedure('public.agentic_position_ledger_block_mutation()') is not null then
    alter function public.agentic_position_ledger_block_mutation()
      set search_path = pg_catalog, public;
  end if;
  if to_regprocedure('public.live_exit_ladder_shadow_block_mutation()') is not null then
    alter function public.live_exit_ladder_shadow_block_mutation()
      set search_path = pg_catalog, public;
  end if;
end
$$;
alter function public.india_news_snapshots_append_only()
  set search_path = pg_catalog, public;
alter function public.prevent_profile_role_self_change()
  set search_path = pg_catalog, public;
alter function public.price_cache_detect_restatement()
  set search_path = pg_catalog, public;
alter function public.price_cache_restatements_append_only()
  set search_path = pg_catalog, public;
alter function public.trial_family_ledger_append_only()
  set search_path = pg_catalog, public;
