-- Reproduce production's autonomous proposal states on a clean database.
-- The production constraint was changed out of band before migration 143 was
-- captured; without this migration, queued autonomous proposals fail their
-- first status update on a fresh rebuild.
alter table public.trade_proposals
  drop constraint if exists trade_proposals_status_check;

alter table public.trade_proposals
  add constraint trade_proposals_status_check check (status in (
    'pending_review',
    'approved',
    'rejected',
    'expired',
    'submitted',
    'filled',
    'failed',
    'cancelled',
    'queued_auto',
    'manual_review_required'
  ));

-- SECURITY DEFINER code must not resolve attacker-controlled objects from the
-- exposed public schema. The function already schema-qualifies every table;
-- pg_catalog supplies built-ins and pg_temp remains last for PostgreSQL internals.
alter function public.promote_strategy_policy(
  uuid, text, text, text, int, int, text, text, int, double precision, boolean, text
) set search_path = pg_catalog, pg_temp;
