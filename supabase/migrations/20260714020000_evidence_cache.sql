-- Canonical Evidence Router — Phase 2 foundation (2/3): durable cache, call
-- ledger, and refresh queue.
--
-- evidence_cache_v2 is the router's own canonical cache (NOT av_cache, which
-- stays as the legacy compatibility cache). The call ledger is an append-only
-- operational audit that stores NO tokens, URLs-with-keys, headers, or raw error
-- bodies. The refresh queue makes a cache-miss-under-no-slot durable instead of a
-- synchronous wall-clock burst. Nothing here scores, orders, or moves money.
--
-- Owner-read RLS; service-role writes. Ledger is append-only. Depends on
-- public.evidence_block_mutation() from 20260714010000_evidence_policy.sql.

-- ── canonical cache (mutable current snapshot per provider/intent/symbol) ─────
create table if not exists public.evidence_cache_v2 (
  market              text not null check (market in ('us','india')),
  symbol              text not null,               -- '__MARKET__' for market-wide intents (never null)
  intent              text not null,
  provider_id         text not null,
  request_fingerprint text not null,               -- contract + normalized request hash
  schema_version      text not null,
  payload             jsonb,                        -- canonical only, size-bounded by the writer
  quality_state       text not null default 'fresh' check (quality_state in ('fresh','stale','partial','conflict','quarantined')),
  observed_at         timestamptz,                  -- semantic time (when the fact became true)
  period_end          date,
  fetched_at          timestamptz not null default now(),
  expires_at          timestamptz,                  -- fresh ceiling
  stale_until         timestamptz,                  -- policy-allowed stale ceiling
  currency            text check (currency in ('USD','INR')),
  basis               text check (basis in ('ttm','forward','annual','quarterly','spot','eod')),
  payload_hash        text,
  primary key (market, symbol, intent, provider_id, request_fingerprint)
);

create index if not exists evidence_cache_v2_lookup_idx
  on public.evidence_cache_v2 (market, symbol, intent, expires_at desc);

-- ── append-only operational call audit (NO secrets) ──────────────────────────
create table if not exists public.provider_call_ledger (
  id               bigint generated always as identity primary key,
  provider         text not null,
  intent           text not null,
  market           text not null check (market in ('us','india')),
  symbol           text,
  run_id           text,
  policy_version   text,
  cache_outcome    text check (cache_outcome in ('fresh','stale','miss')),
  lease_outcome    text check (lease_outcome in ('reserved','started','completed','denied','skipped')),
  started_at       timestamptz,
  completed_at     timestamptz,
  latency_ms       int,
  transport_status text,        -- normalized HTTP/MCP status, never a body
  error_code       text,        -- normalized UnavailableReason, never a raw error
  response_bytes   int,
  contract_version text,
  created_at       timestamptz not null default now()
);

create index if not exists provider_call_ledger_prov_idx
  on public.provider_call_ledger (provider, intent, created_at desc);

drop trigger if exists no_mutate on public.provider_call_ledger;
create trigger no_mutate before update or delete on public.provider_call_ledger
  for each row execute function public.evidence_block_mutation();

-- ── durable refresh queue (one active job per identity) ──────────────────────
create table if not exists public.provider_refresh_jobs (
  id                  bigint generated always as identity primary key,
  market              text not null check (market in ('us','india')),
  symbol              text not null,
  intent              text not null,
  provider_id         text not null,
  request_fingerprint text not null,
  status              text not null default 'queued' check (status in ('queued','leased','done','dead')),
  attempts            int not null default 0,
  next_attempt_at     timestamptz not null default now(),
  lease_until         timestamptz,
  last_error          text,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

-- one ACTIVE job per identity (queued/leased); done/dead rows don't block re-enqueue.
create unique index if not exists provider_refresh_jobs_active_idx
  on public.provider_refresh_jobs (market, symbol, intent, provider_id, request_fingerprint)
  where status in ('queued','leased');

create index if not exists provider_refresh_jobs_claim_idx
  on public.provider_refresh_jobs (status, next_attempt_at)
  where status = 'queued';

-- ── claim RPC: FOR UPDATE SKIP LOCKED, lease + bounded batch ──────────────────
create or replace function public.claim_provider_refresh_jobs(
  p_limit int default 10,
  p_lease_seconds int default 120
) returns setof public.provider_refresh_jobs
language plpgsql
security definer
set search_path = public
as $$
begin
  return query
  update public.provider_refresh_jobs j
  set status = 'leased',
      lease_until = now() + make_interval(secs => p_lease_seconds),
      attempts = j.attempts + 1,
      updated_at = now()
  where j.id in (
    select c.id from public.provider_refresh_jobs c
    where c.status = 'queued' and c.next_attempt_at <= now()
    order by c.next_attempt_at
    for update skip locked
    limit greatest(1, least(p_limit, 100))
  )
  returning j.*;
end $$;

revoke all on function public.claim_provider_refresh_jobs(int, int) from public;
grant execute on function public.claim_provider_refresh_jobs(int, int) to service_role;

-- ── RLS: owner-read, service-role writes ─────────────────────────────────────
do $$
declare t text;
begin
  foreach t in array array[
    'evidence_cache_v2','provider_call_ledger','provider_refresh_jobs'
  ] loop
    execute format('alter table public.%I enable row level security', t);
    execute format($f$
      drop policy if exists %1$s_owner_read on public.%1$s;
      create policy %1$s_owner_read on public.%1$s
        for select to authenticated
        using (((select auth.jwt()) ->> 'email') = 'vterminater@gmail.com');
    $f$, t);
    execute format('grant select on table public.%I to authenticated', t);
  end loop;
end $$;
