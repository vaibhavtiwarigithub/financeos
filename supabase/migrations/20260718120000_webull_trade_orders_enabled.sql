-- webull_trade orders enable flag (Mandatory Gate Ladder, gate 6).
--
-- STATUS: PROPOSAL — NOT YET APPLIED to any environment. Do not apply until the
-- owner confirms the Webull Trading API entitlement and a manually-approved
-- sandbox test has passed. The signed webull_trade adapter reads this column and
-- fails CLOSED while it is absent or false, so shipping the code before this
-- migration runs is safe (the adapter's isConfigured()/submitOrder() refuse).
--
-- False-by-default: adding the column does NOT enable Webull ordering. Flipping
-- it to true is one of NINE independent gates (flag + allowlisted account +
-- vault credential + valid NORMAL token + all the standard money-path gates).
--
-- This is intentionally the ONLY schema this feature needs: no new table, no new
-- cron, no LLM. The allowlisted account lives in the existing broker_accounts
-- table (broker='webull_trade', market='us', role='trading'); the app_key/
-- app_secret live in the existing api_key_vault (provider='webull_trade', with
-- SEPARATE sandbox and prod records).

alter table public.strategy_config
  add column if not exists webull_trade_orders_enabled boolean not null default false;

comment on column public.strategy_config.webull_trade_orders_enabled is
  'Gate 6 for the signed webull_trade adapter. False-by-default kill switch; true is necessary but NOT sufficient to place a Webull order (see lib/brokers/webull-trade/gates.ts). Do not set true until owner entitlement + a sandbox proof.';
