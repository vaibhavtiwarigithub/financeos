-- Immutable trial-family ledger.
--
-- WHY THIS EXISTS. Multiple-testing adjustment is only honest if the trial count
-- is the TOTAL number of specifications ever attempted in a family, across every
-- session and every rerun. Before this table, that count was a plain integer
-- written per experiment row, and it reset. Verified in production 2026-09-01:
--
--   trial_family_id 'local-nse-technical-v1' -> 2 experiments, each recording
--                                               trials_considered = 1
--   13 of 18 backtest_experiments rows       -> trial_family_id NULL entirely
--
-- A Sidak or Deflated-Sharpe threshold computed from a counter that resets is
-- not a correction; it is decoration.
--
-- CONTRACT
--   * Append-only. No update, no delete.
--   * One row per DISTINCT specification within a family. A rerun of a spec
--     already recorded is idempotent and does NOT increment the count.
--   * A parameter variant, an execution adaptation (e.g. "same rule, next-open
--     fills"), a combination, or a different operator/weight IS a new spec and
--     DOES increment.
--   * `trial_index` is assigned under an advisory lock so concurrent workers
--     cannot collide.
--
-- APPLIED to production 2026-09-01 and verified: distinct specs increment,
-- reruns return the existing index with was_new=false, and UPDATE/DELETE are
-- both refused with rows intact.
create table if not exists public.trial_family_ledger (
  id bigserial primary key,
  trial_family_id text not null,
  spec_fingerprint text not null check (spec_fingerprint ~ '^[a-f0-9]{64}$'),
  trial_index integer not null check (trial_index >= 1),
  kind text not null check (kind in ('rule','parameter_variant','adaptation','combination','rerun')),
  label text not null,
  spec jsonb not null,
  adapted_from text,
  registered_by text not null,
  code_version text,
  created_at timestamptz not null default now(),
  unique (trial_family_id, spec_fingerprint),
  unique (trial_family_id, trial_index)
);

create index if not exists trial_family_ledger_family_idx
  on public.trial_family_ledger (trial_family_id, trial_index desc);

alter table public.trial_family_ledger enable row level security;
revoke all on public.trial_family_ledger from anon, authenticated;
grant select on public.trial_family_ledger to authenticated;
create policy trial_family_ledger_owner_read on public.trial_family_ledger
  for select to authenticated
  using ((select auth.jwt() ->> 'email') = 'vterminater@gmail.com');
create policy trial_family_ledger_service_all on public.trial_family_ledger
  for all to service_role using (true) with check (true);

create or replace function public.trial_family_ledger_append_only()
returns trigger language plpgsql as $$
begin
  raise exception 'trial_family_ledger is append-only (attempted % on id %)', tg_op, old.id;
end $$;

drop trigger if exists trial_family_ledger_no_mutate_trg on public.trial_family_ledger;
create trigger trial_family_ledger_no_mutate_trg
  before update or delete on public.trial_family_ledger
  for each row execute function public.trial_family_ledger_append_only();

-- Register a specification and return the family's CURRENT total trial count.
create or replace function public.register_trial(
  p_family text,
  p_spec_fingerprint text,
  p_kind text,
  p_label text,
  p_spec jsonb,
  p_registered_by text,
  p_code_version text default null,
  p_adapted_from text default null
) returns table (trial_index integer, trials_considered integer, was_new boolean)
language plpgsql security definer set search_path = public as $$
declare v_existing integer; v_next integer; v_total integer;
begin
  if p_family is null or p_spec_fingerprint !~ '^[a-f0-9]{64}$' then
    raise exception 'register_trial: family and 64-hex spec_fingerprint are required';
  end if;

  perform pg_advisory_xact_lock(hashtext('trial-family:' || p_family));

  select l.trial_index into v_existing from public.trial_family_ledger l
   where l.trial_family_id = p_family and l.spec_fingerprint = p_spec_fingerprint;

  if v_existing is not null then
    select count(*) into v_total from public.trial_family_ledger
     where trial_family_id = p_family;
    return query select v_existing, v_total, false;
    return;
  end if;

  select coalesce(max(l.trial_index), 0) + 1 into v_next
    from public.trial_family_ledger l where l.trial_family_id = p_family;

  insert into public.trial_family_ledger (
    trial_family_id, spec_fingerprint, trial_index, kind, label, spec,
    adapted_from, registered_by, code_version)
  values (p_family, p_spec_fingerprint, v_next, p_kind, p_label, p_spec,
          p_adapted_from, p_registered_by, p_code_version);

  select count(*) into v_total from public.trial_family_ledger
   where trial_family_id = p_family;
  return query select v_next, v_total, true;
end $$;

revoke all on function public.register_trial(text,text,text,text,jsonb,text,text,text)
  from public, anon, authenticated;
grant execute on function public.register_trial(text,text,text,text,jsonb,text,text,text)
  to service_role;

comment on table public.trial_family_ledger is
  'Append-only count of every specification attempted per trial family. The multiple-testing denominator is max(trial_index) per family, never a per-experiment constant.';
