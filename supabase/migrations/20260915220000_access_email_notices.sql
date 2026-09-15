-- Access email delivery log: what happened to each invitation, sign-in and
-- revoke/delete notice after Resend accepted it.
--
-- WHY A TABLE, NOT MORE COLUMNS. `app_user_roles` references auth.users ON
-- DELETE CASCADE, so deleting an account deletes its grant row in the same
-- moment the deletion notice is sent. A delivery status stored on that row would
-- have nowhere to land. The admin page also said "the notice email sent" when
-- all that was known was that Resend ACCEPTED it (production, 2026-09-15: the
-- deletion notice was accepted and sat in the recipient's spam folder).
--
-- One row per message, keyed by Resend's message id. The route inserts it after
-- a successful send; the webhook only UPDATES rows that already exist.
--
-- LIMIT, stated so nobody over-reads it: `complained` means the recipient
-- clicked "Report spam". A message silently filed into a spam folder is
-- reported by Resend as `delivered`; no provider can see that.
--
-- DISPLAY ONLY. Nothing here grants, restricts or revokes access.

create table if not exists public.access_email_notices (
  email_id     text primary key,
  recipient    text not null,
  kind         text not null check (kind in ('invite', 'resend', 'revoked', 'deleted')),
  sent_at      timestamptz not null default now(),
  status       text not null default 'accepted'
                 check (status in ('accepted', 'delivered', 'bounced', 'complained')),
  status_at    timestamptz,
  status_note  text
);

create index if not exists access_email_notices_recipient_sent_idx
  on public.access_email_notices (recipient, sent_at desc);

-- Service role only: no client policy of any kind. The owner reads it through
-- the owner-gated /api/admin/access route.
alter table public.access_email_notices enable row level security;

comment on table public.access_email_notices is
  'Delivery status of access emails (invite, sign-in resend, revoke and delete notices), keyed by Resend message id. Written by /api/admin/access, updated by the Resend webhook. Display only; never gates access. complained = recipient reported spam; spam-folder placement is invisible and shows as delivered.';
