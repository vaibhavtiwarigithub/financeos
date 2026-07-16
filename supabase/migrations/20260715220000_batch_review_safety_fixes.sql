-- 2026-07-15 Codex batch review: PIT immutability + missing/colliding crons.
-- Data capture/display only. No score, sizing, eligibility, order, or exit path.

-- The application fills first-observed actual fields only when empty. Enforce the
-- invariant in Postgres too so a future service-role bug/upsert cannot rewrite the
-- immutable first observation. Later provider changes use restated_* columns.
create or replace function public.guard_earnings_actual_first_immutable()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if old.eps_actual_first is not null and (
    new.eps_actual_first is distinct from old.eps_actual_first or
    new.revenue_actual_first is distinct from old.revenue_actual_first or
    new.actual_available_at is distinct from old.actual_available_at or
    new.announcement_session is distinct from old.announcement_session or
    new.eps_basis is distinct from old.eps_basis or
    new.actual_currency is distinct from old.actual_currency or
    new.actual_source is distinct from old.actual_source
  ) then
    raise exception 'earnings_calendar first-observed actual fields are immutable';
  end if;
  return new;
end;
$$;

revoke all on function public.guard_earnings_actual_first_immutable() from public, anon, authenticated;

drop trigger if exists earnings_calendar_actual_first_immutable on public.earnings_calendar;
create trigger earnings_calendar_actual_first_immutable
before update on public.earnings_calendar
for each row execute function public.guard_earnings_actual_first_immutable();

-- Consensus vintages are an append-only point-in-time ledger. RLS alone is not
-- enough because service_role bypasses it; reject UPDATE/DELETE in the database.
create or replace function public.block_earnings_consensus_mutation()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  raise exception 'earnings_consensus_snapshots is append-only';
  return old;
end;
$$;

revoke all on function public.block_earnings_consensus_mutation() from public, anon, authenticated;

drop trigger if exists earnings_consensus_append_only on public.earnings_consensus_snapshots;
create trigger earnings_consensus_append_only
before update or delete on public.earnings_consensus_snapshots
for each row execute function public.block_earnings_consensus_mutation();

-- The initial implementation had no scheduled caller, so vintages could not
-- accrue. Capture daily at 02:10 UTC, before the US report date begins in ET.
do $$
begin
  begin
    perform cron.unschedule('kairos-earnings-pit-capture');
  exception when others then null;
  end;
end $$;

select cron.schedule('kairos-earnings-pit-capture', '10 2 * * *',
  $$select public.kairos_call_agent('/api/calendar/earnings/refresh', '{}'::jsonb, 'POST', 115000)$$);

-- The India Markets retry collided exactly with kairos-scan-india-refresh at
-- 10:45 UTC. Move only the retry to an otherwise idle 10:35 slot.
do $$
begin
  begin
    perform cron.unschedule('kairos-india-markets-fill-retry');
  exception when others then null;
  end;
end $$;

select cron.schedule('kairos-india-markets-fill-retry', '35 10 * * 1-5',
  $$select public.kairos_call_agent('/api/markets/india', '{}'::jsonb, 'POST', 65000)$$);
