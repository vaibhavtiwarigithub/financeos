-- Security hardening for the append-only trigger function.
alter function public.discovery_snapshot_members_append_only() set search_path = public;
