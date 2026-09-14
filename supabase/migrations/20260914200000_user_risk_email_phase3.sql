-- Per-User Risk Analytics — Phase 3: the opt-in daily risk email.
-- Spec: features/per-user-broker-risk/FEATURE_ARCHITECTURE.md §5.
--
-- `user_risk_email_prefs` already exists (Phase 0) with enabled=false by
-- default, a send hour, and an unsubscribe token. What Phase 3 adds is the
-- AUDIT: §5 requires "one send per opted-in user per day, with a per-send audit
-- row and a hard cap so a scheduling bug cannot mail in a loop".
--
-- The cap is enforced by the database, not by the sender's own bookkeeping: a
-- unique index on (user_id, send_date) means a second send for the same user on
-- the same day cannot be recorded, and the sender inserts the audit row BEFORE
-- handing anything to the email provider. A retried or duplicated cron loses the
-- unique-insert race and never mails twice. Relying on `last_sent_at` alone
-- would leave the window between "decided to send" and "wrote the timestamp"
-- open to exactly the loop this guards against.
create table if not exists public.user_risk_email_sends (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references auth.users(id) on delete cascade,
  -- The calendar day the send belongs to, in UTC, matching the cron's own day.
  send_date   date not null,
  market      text not null check (market in ('us','india')),
  -- 'sent' | 'failed'. A failure is recorded, not retried into a loop.
  status      text not null check (status in ('sent','failed')),
  detail      text,
  created_at  timestamptz not null default now()
);

-- The hard cap. One row per user per day, whatever the market: the digest is one
-- email covering the user's connected markets, not one per market.
create unique index if not exists user_risk_email_sends_once_per_day
  on public.user_risk_email_sends (user_id, send_date);

create index if not exists user_risk_email_sends_user_idx
  on public.user_risk_email_sends (user_id, created_at desc);

alter table public.user_risk_email_sends enable row level security;

-- Self-read only, consistent with every other user_* table: a person may see
-- that they were emailed. Writes are service-role (which bypasses RLS), and
-- there is deliberately no owner read policy — the owner administers access,
-- not anyone's mail history.
drop policy if exists "user_risk_email_sends_self_read" on public.user_risk_email_sends;
create policy "user_risk_email_sends_self_read" on public.user_risk_email_sends
  for select to authenticated using (user_id = (select auth.uid()));

-- Unsubscribe must work WITHOUT a login, so the route looks the token up with
-- the service role. Index it so that lookup is not a scan.
create index if not exists user_risk_email_prefs_unsub_idx
  on public.user_risk_email_prefs (unsubscribe_token);
