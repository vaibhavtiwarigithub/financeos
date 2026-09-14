-- Shared Viewer Access — Phase 1: role grants, and close the profiles.role
-- self-promotion path.
--
-- features/shared-viewer-access/FEATURE_ARCHITECTURE.md Phase 1. Owner-approved
-- 2026-09-14. Creates the grant store only; it ships NO viewer (the table starts
-- empty) and no invitation.
--
-- WHY A NEW TABLE. `profiles` carries a `role` column under
-- `FOR ALL USING (auth.uid() = id)` with NO `WITH CHECK`, so any signed-in user
-- can UPDATE THEIR OWN ROLE. middleware.ts gates /admin on exactly
-- `profiles.role in ('admin','superadmin')`. Today that is unreachable because
-- only the owner can sign in, but the moment a guest exists it is a
-- self-promotion path straight to /admin. Authorization therefore lives in this
-- table, which only service-role can write, and the column grant below removes
-- the escalation regardless.

create table if not exists public.app_user_roles (
  user_id     uuid primary key references auth.users(id) on delete cascade,
  email       text not null,
  role        text not null default 'viewer' check (role in ('viewer')),
  granted_at  timestamptz not null default now(),
  granted_by  text not null,
  revoked_at  timestamptz,
  revoked_by  text,
  note        text
);

comment on table public.app_user_roles is
  'Owner-managed guest access grants. The ONLY authority for a non-owner role. Owner identity is never stored here - it is lib/auth/owner.ts OWNER_EMAIL. Service-role writes only; revocation is revoked_at, never a delete, so the grant history survives.';

create index if not exists app_user_roles_active_idx
  on public.app_user_roles (user_id) where revoked_at is null;

alter table public.app_user_roles enable row level security;

-- Owner may read the grant list in the browser; nobody else can read it at all,
-- and no client role may write it. Writes are service-role (rolbypassrls) only.
drop policy if exists "app_user_roles_owner_read" on public.app_user_roles;
create policy "app_user_roles_owner_read" on public.app_user_roles
  for select to authenticated
  using (((select auth.jwt()) ->> 'email'::text) = 'vterminater@gmail.com'::text);

-- Close the escalation. A column-level REVOKE does NOT work here: `authenticated`
-- holds a TABLE-level UPDATE grant on profiles, and Postgres will not subtract a
-- single column from it (verified against production - the revoke ran without
-- error and left both grants in place). A trigger is therefore the enforcement.
-- It keys on current_user, the Postgres role PostgREST switches to, rather than
-- auth.role(), which reads a JWT claim that is absent (NULL) in some contexts and
-- would silently fail open.
create or replace function public.prevent_profile_role_self_change()
returns trigger language plpgsql as $$
begin
  if new.role is distinct from old.role
     and current_user not in ('service_role','postgres','supabase_admin') then
    raise exception 'profiles.role may only be changed by service-role (attempted by %)', current_user;
  end if;
  return new;
end $$;

drop trigger if exists profiles_role_immutable_from_client on public.profiles;
create trigger profiles_role_immutable_from_client
  before update on public.profiles
  for each row execute function public.prevent_profile_role_self_change();

-- Verified in production inside a rolled-back transaction, as role `authenticated`
-- with request.jwt.claims set to the owner's own id:
--   UPDATE profiles SET role='superadmin_escalated' -> raises P0001 (blocked)
--   UPDATE profiles SET email=email                 -> 1 row (benign write still works)
