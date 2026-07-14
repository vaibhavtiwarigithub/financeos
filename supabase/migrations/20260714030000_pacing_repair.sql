-- Canonical Evidence Router — Phase 2 foundation (3/3): pacing schema repair.
--
-- provider_pacing + try_acquire_provider_slot were applied to PRODUCTION out of
-- band (as "migration 176") but were never tracked in this repo. This migration
-- reconciles the repo with the LIVE schema, verified via information_schema /
-- pg_get_functiondef on 2026-07-14, so a fresh environment rebuilds identically.
-- It is IDEMPOTENT and must exactly match what is already live — it does NOT
-- rename, drop, or alter the running table/function's semantics. No money path.
--
-- Live shape (verified): provider_pacing(provider text not null,
-- min_interval_ms int not null, last_started_at timestamptz) with pk(provider);
-- try_acquire_provider_slot(text, int) -> boolean, atomic lease via upsert.

create table if not exists public.provider_pacing (
  provider        text primary key,
  min_interval_ms integer not null,
  last_started_at timestamptz
);

-- Exact live definition — atomic per-provider min-interval lease. Returns true
-- only if the caller acquired the slot (interval elapsed or first call).
create or replace function public.try_acquire_provider_slot(p_provider text, p_min_interval_ms integer)
returns boolean
language plpgsql
as $function$
declare n int;
begin
  insert into provider_pacing(provider, min_interval_ms, last_started_at)
    values (p_provider, p_min_interval_ms, now())
  on conflict (provider) do update
    set last_started_at = now(), min_interval_ms = p_min_interval_ms
    where provider_pacing.last_started_at is null
       or provider_pacing.last_started_at + make_interval(secs => p_min_interval_ms / 1000.0) <= now();
  get diagnostics n = row_count;
  return n > 0;
end $function$;
