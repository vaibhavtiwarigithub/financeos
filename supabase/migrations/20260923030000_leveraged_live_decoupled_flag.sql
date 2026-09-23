-- Decouple the leveraged sleeve's live-enable toggle from core-equity
-- AutonomousLive's own strategy_config.live_auto_enabled. Owner flagged
-- (2026-09-23, at the moment of actually enabling live trading) that
-- reusing the shared flag would silently also enable core-equity
-- autonomous live trading -- a completely separate, much larger, never-
-- fired system -- as a side effect of enabling the $250 leveraged sleeve.
-- Chose to decouple rather than flip both at once.
alter table public.strategy_config
  add column if not exists leveraged_live_auto_enabled boolean not null default false;

comment on column public.strategy_config.leveraged_live_auto_enabled is
  'DB toggle for the leveraged sleeve''s own live door (SOXL/TQQQ/SQQQ/SOXS), paired with the LEVERAGED_LIVE_ENABLED env var. Deliberately separate from live_auto_enabled, which gates core-equity AutonomousLive only.';
