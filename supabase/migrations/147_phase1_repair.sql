-- 147: Phase 1 schema repair (additive, idempotent on production).
--
-- Migration 143 restored broker_orders / trade_proposals / broker_order_events
-- and reserve_live_order_budget_v2 from out-of-band 139/140, but missed the
-- strategy_config live_auto_* columns that 139 added. A fresh database built from
-- migrations would be missing those columns, breaking autonomous-live.ts.
--
-- Production already has all columns and the RPC permission is already locked.
-- Every statement here is a no-op on production.

-- 1. strategy_config autonomous-live control columns (out-of-band 139) ----------
ALTER TABLE public.strategy_config
  ADD COLUMN IF NOT EXISTS live_auto_enabled              boolean     NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS live_auto_enabled_until        timestamptz,
  ADD COLUMN IF NOT EXISTS live_auto_policy_version       integer     NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS live_auto_daily_cap_usd        numeric,
  ADD COLUMN IF NOT EXISTS live_auto_max_per_order_usd    numeric,
  ADD COLUMN IF NOT EXISTS live_auto_min_evidence_confidence numeric,
  ADD COLUMN IF NOT EXISTS live_auto_max_open_positions   integer,
  ADD COLUMN IF NOT EXISTS live_auto_max_orders_per_day   integer;

-- Per-market autonomous mode (out-of-band 141 — also captured in 141 file, but
-- ADD COLUMN IF NOT EXISTS is safe to repeat).
ALTER TABLE public.strategy_config
  ADD COLUMN IF NOT EXISTS live_auto_mode_us              text        NOT NULL DEFAULT 'manual',
  ADD COLUMN IF NOT EXISTS live_auto_mode_india           text        NOT NULL DEFAULT 'manual';

-- 2. Harden reserve_live_order_budget_v2 execute permissions --------------------
-- Out-of-band 140 revoked PUBLIC and granted service_role; record it here so a
-- fresh build applies the same lock. Already a no-op on production (ACL confirmed
-- {postgres=X/postgres,service_role=X/postgres} on 2026-07-10).
REVOKE EXECUTE ON FUNCTION public.reserve_live_order_budget_v2(
  bigint, text, text, text, text, text, numeric, text, numeric, numeric, text,
  integer, numeric, text
) FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.reserve_live_order_budget_v2(
  bigint, text, text, text, text, text, numeric, text, numeric, numeric, text,
  integer, numeric, text
) TO service_role;
