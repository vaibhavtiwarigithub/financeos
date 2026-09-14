-- Per-User Broker Connections & Private Risk Analytics — Phase 0: schema only.
--
-- features/per-user-broker-risk/FEATURE_ARCHITECTURE.md, owner-approved
-- 2026-09-14. Tables only: no UI, no job, no credential, no email. Every table
-- ships EMPTY, so nothing about the owner's existing behaviour changes.
--
-- WHY NEW `user_*` TABLES RATHER THAN `user_id` ON THE OWNER'S TABLES.
-- Adding a column to `live_account_snapshots` or `holding_risk_snapshots` would
-- put guest rows inside the tables the owner's live pages, kill-switch NAV
-- baseline and Guardian already read. One missed filter and a guest's position
-- silently enters an owner money-path calculation. Separate tables make that
-- class of bug impossible rather than merely tested for.
--
-- ISOLATION MODEL. Every table is keyed by `user_id` and readable only by that
-- user (`auth.uid()`). There is deliberately NO owner read policy: the owner
-- administers ACCESS, not POSITIONS. Writes are service-role only (service_role
-- has rolbypassrls, so it needs no policy).

-- ── Credentials ─────────────────────────────────────────────────────────────
-- Ciphertext only, produced by lib/security/credential-cipher.ts (AES-256-GCM
-- with a server-held key). A database read alone is therefore not enough to use
-- someone's brokerage account.
create table if not exists public.user_broker_credentials (
  user_id            uuid not null references auth.users(id) on delete cascade,
  broker             text not null check (broker in ('robinhood','kite')),
  -- The ONLY permitted value. There is no enum member meaning "can trade", so a
  -- future bug cannot widen a guest connection into an order-capable one.
  scope              text not null default 'read_only' check (scope = 'read_only'),
  ciphertext         text not null,
  -- Non-reversible; lets support answer "same token as yesterday?" without the
  -- token appearing anywhere.
  fingerprint        text,
  -- Kite access tokens expire every trading day. Owner-approved decision
  -- (2026-09-14, option a): accept the daily login, but show staleness LOUDLY.
  -- This column is what the UI and the email read to do that.
  expires_at         timestamptz,
  connected_at       timestamptz not null default now(),
  last_verified_at   timestamptz,
  last_error         text,
  disconnected_at    timestamptz,
  primary key (user_id, broker)
);

comment on table public.user_broker_credentials is
  'Per-user READ-ONLY broker credentials, encrypted at rest. Never returned by any API, never logged, never rendered. Separate from api_key_vault, which holds the owner''s own app-level provider keys.';

-- ── Holdings snapshot ───────────────────────────────────────────────────────
create table if not exists public.user_account_snapshots (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references auth.users(id) on delete cascade,
  broker        text not null check (broker in ('robinhood','kite')),
  market        text not null check (market in ('us','india')),
  account_ref   text,
  captured_at   timestamptz not null default now(),
  -- The session the holdings belong to, so a stale capture is visible as stale
  -- rather than inferred from captured_at.
  as_of_date    date,
  currency      text,
  nav           numeric,
  holdings      jsonb not null default '[]'::jsonb,
  stale_reason  text
);

create index if not exists user_account_snapshots_user_idx
  on public.user_account_snapshots (user_id, market, captured_at desc);

-- ── Risk output ─────────────────────────────────────────────────────────────
create table if not exists public.user_holding_risk_runs (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references auth.users(id) on delete cascade,
  market        text not null check (market in ('us','india')),
  status        text not null check (status in ('ok','skipped','error')),
  -- A skip is always explained (expired token, no connection, revoked access).
  -- Silence is never an acceptable outcome for a money-adjacent report.
  skip_reason   text,
  as_of_date    date,
  started_at    timestamptz not null default now(),
  completed_at  timestamptz,
  summary       jsonb
);

create index if not exists user_holding_risk_runs_user_idx
  on public.user_holding_risk_runs (user_id, market, started_at desc);

create table if not exists public.user_holding_risk_snapshots (
  id            uuid primary key default gen_random_uuid(),
  run_id        uuid not null references public.user_holding_risk_runs(id) on delete cascade,
  user_id       uuid not null references auth.users(id) on delete cascade,
  market        text not null check (market in ('us','india')),
  symbol        text not null,
  as_of_date    date,
  metrics       jsonb not null default '{}'::jsonb,
  created_at    timestamptz not null default now()
);

create index if not exists user_holding_risk_snapshots_user_idx
  on public.user_holding_risk_snapshots (user_id, market, as_of_date desc);

-- ── Daily risk email preference ─────────────────────────────────────────────
create table if not exists public.user_risk_email_prefs (
  user_id            uuid primary key references auth.users(id) on delete cascade,
  -- OFF by default. An invitation to view is not consent to be emailed.
  enabled            boolean not null default false,
  send_hour_utc      smallint not null default 12 check (send_hour_utc between 0 and 23),
  -- Unsubscribe must work without a login, so it needs its own secret.
  unsubscribe_token  text not null default encode(gen_random_bytes(24), 'hex'),
  last_sent_at       timestamptz,
  created_at         timestamptz not null default now()
);

-- ── RLS: each user sees only their own rows; nobody sees anyone else's ───────
alter table public.user_broker_credentials    enable row level security;
alter table public.user_account_snapshots     enable row level security;
alter table public.user_holding_risk_runs     enable row level security;
alter table public.user_holding_risk_snapshots enable row level security;
alter table public.user_risk_email_prefs      enable row level security;

-- NOTE: user_broker_credentials gets NO select policy at all, not even for its
-- own user. Nothing legitimate reads the ciphertext from a browser — the server
-- decrypts it. Connection STATE is served by an API route from the non-secret
-- columns. This keeps the ciphertext unreachable from any client session.

drop policy if exists "user_account_snapshots_self_read" on public.user_account_snapshots;
create policy "user_account_snapshots_self_read" on public.user_account_snapshots
  for select to authenticated using (user_id = (select auth.uid()));

drop policy if exists "user_holding_risk_runs_self_read" on public.user_holding_risk_runs;
create policy "user_holding_risk_runs_self_read" on public.user_holding_risk_runs
  for select to authenticated using (user_id = (select auth.uid()));

drop policy if exists "user_holding_risk_snapshots_self_read" on public.user_holding_risk_snapshots;
create policy "user_holding_risk_snapshots_self_read" on public.user_holding_risk_snapshots
  for select to authenticated using (user_id = (select auth.uid()));

drop policy if exists "user_risk_email_prefs_self_read" on public.user_risk_email_prefs;
create policy "user_risk_email_prefs_self_read" on public.user_risk_email_prefs
  for select to authenticated using (user_id = (select auth.uid()));
