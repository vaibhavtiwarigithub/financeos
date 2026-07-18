-- Edge/factor evidence hardening and bounded collection schedules.
-- Measure-only: no table created or changed here is read by scoring, sizing,
-- paper trading, live trading, or exits.

alter table public.edge_signal_inputs
  add column if not exists observed_at timestamptz,
  add column if not exists provenance_mode text,
  add column if not exists input_fingerprint text;

alter table public.edge_signal_inputs
  drop constraint if exists edge_signal_inputs_provenance_mode_ck;
alter table public.edge_signal_inputs
  add constraint edge_signal_inputs_provenance_mode_ck check (
    provenance_mode is null or provenance_mode in (
      'prospective_capture',
      'retrospective_reconstruction',
      'legacy_unverified'
    )
  );

-- Existing rows used a synthetic next-session available_at. Preserve them for
-- audit, but mark them explicitly ineligible for point-in-time proof.
update public.edge_signal_inputs
set provenance_mode = 'legacy_unverified'
where provenance_mode is null;

alter table public.edge_signals
  add column if not exists observed_at timestamptz,
  add column if not exists provenance_mode text,
  add column if not exists input_fingerprint text;

update public.edge_signals
set observed_at = coalesce(observed_at, created_at),
    provenance_mode = coalesce(provenance_mode, 'legacy_unverified'),
    input_fingerprint = coalesce(input_fingerprint, 'legacy:' || id::text)
where observed_at is null or provenance_mode is null or input_fingerprint is null;

alter table public.edge_signals
  alter column observed_at set not null,
  alter column provenance_mode set not null,
  alter column input_fingerprint set not null;

alter table public.edge_signals
  drop constraint if exists edge_signals_symbol_date_edge_id_market_key;
create unique index if not exists edge_signals_observation_uniq
  on public.edge_signals (symbol, date, edge_id, market, input_fingerprint);

create or replace function public.edge_signals_block_update()
returns trigger language plpgsql set search_path = '' as $$
begin
  raise exception 'edge_signals observations are immutable; append a revised fingerprint';
end;
$$;
drop trigger if exists edge_signals_no_update on public.edge_signals;
create trigger edge_signals_no_update before update on public.edge_signals
  for each row execute function public.edge_signals_block_update();
revoke execute on function public.edge_signals_block_update() from public, anon, authenticated;

alter table public.edge_ic_history
  add column if not exists n_obs integer,
  add column if not exists universe_size integer,
  add column if not exists as_of_dates integer,
  add column if not exists step_days integer,
  add column if not exists history_days integer,
  add column if not exists evidence_quality text,
  add column if not exists provider_report jsonb not null default '{}'::jsonb;

alter table public.edge_ic_history
  drop constraint if exists edge_ic_history_counts_ck;
alter table public.edge_ic_history
  add constraint edge_ic_history_counts_ck check (
    (n_obs is null or n_obs >= 0) and
    (universe_size is null or universe_size >= 0) and
    (as_of_dates is null or as_of_dates >= 0) and
    (step_days is null or step_days > 0) and
    (history_days is null or history_days > 0)
  );

-- Lifecycle status is a property of edge x market, never a global catalog
-- property. Horizon detail remains in edge_ic_history.
create table if not exists public.edge_market_status (
  edge_id            text not null references public.edge_catalog(edge_id),
  market             text not null check (market in ('us','india')),
  status             text not null check (status in (
    'candidate','measure_only','shadow_eligible','benched_negative',
    'exploratory_paper','active_paper','live_eligible','live_approved','retired'
  )),
  latest_window_end  date,
  n_obs_min          integer check (n_obs_min is null or n_obs_min >= 0),
  evidence_quality   text not null,
  horizon_statuses   jsonb not null default '{}'::jsonb,
  updated_at         timestamptz not null default now(),
  primary key (edge_id, market)
);

alter table public.edge_market_status enable row level security;
revoke all on table public.edge_market_status from anon, authenticated;

-- Retire the misleading global lifecycle label. It remains for compatibility,
-- but is now catalog-level only and must never be used as market evidence.
update public.edge_catalog set status = 'measure_only' where status <> 'measure_only';

-- Bounded, post-market prospective snapshots. Each run is intentionally
-- market-specific so health checks and evidence never cross markets.
do $$
declare j text;
begin
  foreach j in array array[
    'kairos-edge-scout-us','kairos-edge-scout-india',
    'kairos-edge-ic-us','kairos-edge-ic-india'
  ] loop
    begin perform cron.unschedule(j); exception when others then null; end;
  end loop;
end $$;

select cron.schedule(
  'kairos-edge-scout-us', '30 22 * * 1-5',
  $$select public.kairos_call_agent('/api/agents/edge-scout?market=us&maxSymbols=50', '{}'::jsonb, 'POST', 290000)$$
);
select cron.schedule(
  'kairos-edge-scout-india', '30 11 * * 1-5',
  $$select public.kairos_call_agent('/api/agents/edge-scout?market=india&maxSymbols=50', '{}'::jsonb, 'POST', 290000)$$
);

-- Weekly historical diagnostics run off-cycle. They remain retrospective and
-- cannot promote anything; prospective daily snapshots are the promotion-grade
-- path once their forward labels mature.
select cron.schedule(
  'kairos-edge-ic-us', '0 2 * * 1',
  $$select public.kairos_call_agent('/api/agents/edge-ic?market=us&universe=liquid&maxSymbols=40&maxDates=120&stepDays=5&historyDays=1000', '{}'::jsonb, 'POST', 290000)$$
);
select cron.schedule(
  'kairos-edge-ic-india', '0 3 * * 1',
  $$select public.kairos_call_agent('/api/agents/edge-ic?market=india&universe=liquid&maxSymbols=40&maxDates=120&stepDays=5&historyDays=1000', '{}'::jsonb, 'POST', 290000)$$
);
