-- Migration 124 — Autonomy ladder (strategic review S1 / Build 1)
--
-- Adds a single declared maturity level to strategy_config. It is an ADDITIVE
-- master gate stacked on top of the existing money controls (trading_enabled,
-- per-market flags, kill switches) — ALL must pass for a live order.
--
-- Default is 'L3_live_manual' to PRESERVE current behavior exactly: the owner
-- already drafts/approves each live order via requireOwner() in the broker/kite
-- gateways. Nothing is newly blocked or newly allowed by this default.
--
-- Levels L4_live_small_auto / L5_scaled_auto DESCRIBE a future autonomous
-- envelope but are NOT honored by any code path — lib/autonomy.ts keeps
-- AUTONOMOUS_LIVE_ENABLED=false, so owner click stays mandatory. Additive,
-- idempotent, safe to re-run.

alter table strategy_config
  add column if not exists autonomy_level text not null default 'L3_live_manual';

-- Constrain to the known ladder rungs. Guarded so re-running is a no-op.
do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'strategy_config_autonomy_level_chk'
  ) then
    alter table strategy_config
      add constraint strategy_config_autonomy_level_chk
      check (autonomy_level in (
        'L0_research',
        'L1_paper_auto',
        'L2_shadow',
        'L3_live_manual',
        'L4_live_small_auto',
        'L5_scaled_auto'
      ));
  end if;
end $$;
