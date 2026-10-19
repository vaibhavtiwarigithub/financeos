-- Persist broker-reported account state alongside live account snapshots.
-- This is observational metadata only; it grants no order authority.
alter table public.live_account_snapshots
  add column if not exists account_state_json jsonb;

comment on column public.live_account_snapshots.account_state_json is
  'Sanitized broker-reported account status and restrictions; never credentials or secrets.';
