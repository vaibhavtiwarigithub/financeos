-- Invite delivery state: make a dead invitation visible instead of green.
--
-- WHY. `POST /api/admin/access {action:"invite"}` wrote the grant as soon as
-- Resend ACCEPTED the message, and the access page rendered every un-revoked
-- grant as "Active". Neither fact means the person can sign in:
--
--   * `generateLink` creates an `auth.users` row for any syntactically valid
--     address. It does not check that the mailbox exists.
--   * Resend returns success on ACCEPTANCE. A dead mailbox bounces
--     asynchronously, minutes later, reported only by webhook.
--
-- So a typo'd address left an orphan auth user and a grant the owner's own
-- screen claimed was active, for someone who never received anything. The
-- access is inert — no link, no session — but the page was lying about who
-- has access, which is the part that matters on a page whose entire job is
-- answering "who can see my book?".
--
-- The fix needs two facts the table did not carry. Acceptance (has the invite
-- been accepted?) is already recorded by Supabase as `auth.users.confirmed_at`
-- and is read from there, NOT copied here — one authority, no drift.
-- Deliverability is what these columns add.
--
-- DELIVERABILITY IS NOT ACCESS. These columns never gate a request. A bounce
-- says the EMAIL failed, not that the person is untrusted: someone who already
-- accepted and whose mailbox later fills up keeps their access. Revocation
-- remains the only thing that removes it, and stays `revoked_at`.
alter table public.app_user_roles
  -- Resend's id for the invitation message, so a webhook can match a bounce to
  -- THIS grant exactly rather than guessing by recipient address.
  add column if not exists invite_email_id     text,
  add column if not exists invite_sent_at      timestamptz,
  -- Set by the Resend webhook; cleared by a later successful delivery and by
  -- re-inviting, so a fixed mailbox stops showing a stale warning.
  add column if not exists undeliverable_at    timestamptz,
  -- 'bounced' | 'complained' — a bounce is a dead mailbox, a complaint is a
  -- live person who marked it spam. Very different problems; do not merge them.
  add column if not exists undeliverable_kind  text,
  add column if not exists undeliverable_note  text;

create index if not exists app_user_roles_invite_email_id_idx
  on public.app_user_roles (invite_email_id) where invite_email_id is not null;

comment on column public.app_user_roles.invite_email_id is
  'Resend message id of the invitation, used to match webhook bounce events to this exact grant. Not a credential.';
comment on column public.app_user_roles.undeliverable_at is
  'Set by the Resend webhook when the invitation bounced or was marked spam. Informational only - it NEVER gates access. Cleared by a successful delivery or a re-invite.';
comment on column public.app_user_roles.undeliverable_kind is
  'bounced (dead mailbox) or complained (marked as spam). Distinct problems.';
