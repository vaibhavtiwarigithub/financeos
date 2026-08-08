-- Owner property records are mutable current state. This ledger preserves the
-- valuation and carrying-cost snapshots that produced each displayed history
-- point, while keeping private values encrypted before they enter Postgres.

alter table public.property_assets
  add column if not exists archived_at timestamptz;

create table if not exists public.property_asset_history (
  id bigint generated always as identity primary key,
  owner_id uuid not null references auth.users(id) on delete cascade,
  property_asset_id uuid not null references public.property_assets(id) on delete restrict,
  event_kind text not null check (event_kind = 'snapshot'),
  as_of date not null default current_date,
  encrypted_payload text not null,
  created_at timestamptz not null default now()
);

create index if not exists property_asset_history_owner_asset_as_of_idx
  on public.property_asset_history (owner_id, property_asset_id, as_of, id);
create index if not exists property_assets_active_owner_updated_idx
  on public.property_assets (owner_id, updated_at desc)
  where archived_at is null;

alter table public.property_asset_history enable row level security;
revoke all on public.property_asset_history from anon, authenticated;

-- The history itself is immutable, including against the service role. The
-- only permitted service-role action is INSERT through the atomic write RPCs.
drop trigger if exists property_asset_history_append_only on public.property_asset_history;
create trigger property_asset_history_append_only
  before update or delete on public.property_asset_history
  for each row execute function public.prevent_property_evidence_mutation();
drop trigger if exists property_asset_history_no_truncate on public.property_asset_history;
create trigger property_asset_history_no_truncate
  before truncate on public.property_asset_history
  for each statement execute function public.prevent_property_evidence_truncate();
revoke update, delete, truncate on public.property_asset_history from service_role;

create or replace function public.create_property_asset_with_history(
  p_owner_id uuid,
  p_geography_slug text,
  p_asset_type text,
  p_display_label text,
  p_encrypted_payload text,
  p_history_payload text,
  p_as_of date
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_asset_id uuid;
begin
  insert into public.property_assets (
    owner_id, geography_slug, asset_type, display_label, encrypted_payload
  ) values (
    p_owner_id, p_geography_slug, p_asset_type, p_display_label, p_encrypted_payload
  ) returning id into v_asset_id;

  insert into public.property_asset_history (
    owner_id, property_asset_id, event_kind, as_of, encrypted_payload
  ) values (
    p_owner_id, v_asset_id, 'snapshot', coalesce(p_as_of, current_date), p_history_payload
  );

  return v_asset_id;
end;
$$;

create or replace function public.update_property_asset_with_history(
  p_owner_id uuid,
  p_asset_id uuid,
  p_geography_slug text,
  p_asset_type text,
  p_display_label text,
  p_encrypted_payload text,
  p_history_payload text,
  p_as_of date
)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  update public.property_assets
  set geography_slug = p_geography_slug,
      asset_type = p_asset_type,
      display_label = p_display_label,
      encrypted_payload = p_encrypted_payload,
      updated_at = now()
  where id = p_asset_id
    and owner_id = p_owner_id
    and archived_at is null;

  if not found then
    return false;
  end if;

  insert into public.property_asset_history (
    owner_id, property_asset_id, event_kind, as_of, encrypted_payload
  ) values (
    p_owner_id, p_asset_id, 'snapshot', coalesce(p_as_of, current_date), p_history_payload
  );

  return true;
end;
$$;

create or replace function public.archive_property_asset(
  p_owner_id uuid,
  p_asset_id uuid
)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  update public.property_assets
  set archived_at = now(), updated_at = now()
  where id = p_asset_id
    and owner_id = p_owner_id
    and archived_at is null;

  return found;
end;
$$;

revoke all on function public.create_property_asset_with_history(uuid, text, text, text, text, text, date) from public, anon, authenticated;
revoke all on function public.update_property_asset_with_history(uuid, uuid, text, text, text, text, text, date) from public, anon, authenticated;
revoke all on function public.archive_property_asset(uuid, uuid) from public, anon, authenticated;
grant execute on function public.create_property_asset_with_history(uuid, text, text, text, text, text, date) to service_role;
grant execute on function public.update_property_asset_with_history(uuid, uuid, text, text, text, text, text, date) to service_role;
grant execute on function public.archive_property_asset(uuid, uuid) to service_role;
