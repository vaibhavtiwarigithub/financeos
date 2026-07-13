-- 173: server-side OAuth PKCE state (CSRF state + PKCE verifier).
--
-- WHY: the Webull (and pattern for any multi-screen OAuth) connect kept its
-- state+verifier in a 10-min HttpOnly cookie. Webull's OAuth spans several
-- screens (login -> trading password -> account select -> capability select), so
-- the cookie routinely expired or wasn't returned on the cross-domain callback,
-- producing "OAuth state check failed" even after a successful authorize.
-- Storing it server-side keyed by the state nonce is immune to cookie/domain/
-- expiry; the callback looks it up. Single-use (deleted on read), 30-min TTL.
--
-- SECURITY: RLS ON with NO policies — only the service client (which bypasses
-- RLS) may read/write. The CSRF state + PKCE verifier must never be exposed to
-- an app/anon role.

create table if not exists public.oauth_pkce_state (
  state        text primary key,
  provider     text not null,
  verifier     text not null,
  redirect_uri text,
  created_at   timestamptz not null default now(),
  expires_at   timestamptz not null
);

alter table public.oauth_pkce_state enable row level security;

create index if not exists oauth_pkce_state_expires_idx on public.oauth_pkce_state (expires_at);
