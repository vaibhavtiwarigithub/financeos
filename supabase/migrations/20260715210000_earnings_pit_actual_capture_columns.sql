-- Point-in-time earnings DATA CAPTURE (features/known-anomalies §3).
-- Adds first-reported-actual + announcement-session columns to earnings_calendar.
-- DATA CAPTURE ONLY: no scoring/sizing/order/exit reads these. Deterministic.
--
-- Invariants enforced here:
--   * eps_actual_first is the immutable FIRST-reported actual. Application code
--     never overwrites it; later corrections land in restated_eps instead.
--   * actual_available_at records when WE could first know the value (point-in-time).
--   * announcement_session in (before_open,during_session,after_close,unknown).
-- RLS is already enabled on earnings_calendar (migration 20260715120000); these
-- are additive columns only, so the existing authenticated-read / service-write
-- policy continues to apply unchanged.

alter table public.earnings_calendar
  add column if not exists market                text not null default 'us',
  add column if not exists eps_actual_first       numeric,
  add column if not exists revenue_actual_first   bigint,
  add column if not exists actual_available_at    timestamptz,
  add column if not exists announcement_session   text,
  add column if not exists eps_basis              text,
  add column if not exists actual_currency        text default 'USD',
  add column if not exists actual_source          text,
  add column if not exists restated_eps           numeric,
  add column if not exists restated_available_at  timestamptz,
  add column if not exists restated_source        text;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'earnings_calendar_session_chk'
  ) then
    alter table public.earnings_calendar
      add constraint earnings_calendar_session_chk
      check (announcement_session is null
             or announcement_session in ('before_open','during_session','after_close','unknown'));
  end if;
  if not exists (
    select 1 from pg_constraint where conname = 'earnings_calendar_market_chk'
  ) then
    alter table public.earnings_calendar
      add constraint earnings_calendar_market_chk
      check (market in ('us','india'));
  end if;
end $$;

create index if not exists earnings_calendar_market_report_date_idx
  on public.earnings_calendar (market, report_date);
