-- Historical Replay Harness — frozen point-in-time eligibility tables.
--
-- Proposed in features/historical-replay-harness/FEATURE_ARCHITECTURE.md §5.
-- Four ADDITIVE tables. Idempotent (create-if-not-exists throughout). This file is
-- NOT applied by CI automatically and is not read by any live/cron path — the harness
-- is OFF by default and measure-only. Per the global schema rule, verify this migration
-- is applied to the target DB before any code that DEPENDS on these tables ships. The
-- P0–P4 harness code does NOT depend on these tables (it runs on in-memory fixtures),
-- so it is safe to land ahead of applying this migration.
--
-- Immutability of replay_packets / replay_packet_items is a WRITE-ONCE convention here
-- (assembler deep-freezes in memory; a mutation-blocking trigger can be added when the
-- harness is wired to persist, alongside the code that writes these rows).

-- 1. One row per (symbol, as-of date). Immutable after write.
create table if not exists public.replay_packets (
  id                          bigint generated always as identity primary key,
  cohort                      text not null,                 -- e.g. 'semis_memory_2022'
  symbol                      text not null,
  market                      text not null,                 -- 'us' | 'india'
  as_of                       date not null,
  manifest_hash               text not null,                 -- sha256 over the frozen item set
  publication_lag_assumptions jsonb not null default '{}'::jsonb,
  created_at                  timestamptz not null default now(),
  unique (cohort, symbol, as_of)
);

create index if not exists idx_replay_packets_cohort_asof
  on public.replay_packets(cohort, as_of);

-- 2. The frozen inputs. knowable_at <= packet.as_of is the invariant the sealed
--    accessor enforces at read time and a backfill test asserts at write time.
create table if not exists public.replay_packet_items (
  id           bigint generated always as identity primary key,
  packet_id    bigint not null references public.replay_packets(id) on delete cascade,
  item_type    text not null check (item_type in ('ohlcv','fundamental','news','universe')),
  symbol       text not null,
  knowable_at  timestamptz not null,                         -- when this datum was public
  source       text,
  source_tier  int,
  payload      jsonb not null,
  payload_hash text not null,
  created_at   timestamptz not null default now()
);

create index if not exists idx_replay_packet_items_packet
  on public.replay_packet_items(packet_id);
create index if not exists idx_replay_packet_items_type_knowable
  on public.replay_packet_items(item_type, knowable_at);

-- 3. One row per replay execution. packet_manifest_hash + code_git_sha make a run
--    reproducible from its frozen inputs and the gate code version.
create table if not exists public.replay_eligibility_runs (
  id                    bigint generated always as identity primary key,
  cohort                text not null,
  model_kind            text not null,                       -- e.g. 'pwin_logistic'
  setup                 text,
  horizon_days          int not null,
  window_start          date not null,
  window_end            date not null,
  packet_manifest_hash  text,
  code_git_sha          text,
  created_at            timestamptz not null default now()
);

create index if not exists idx_replay_eligibility_runs_cohort
  on public.replay_eligibility_runs(cohort, created_at desc);

-- 4. Per (run, symbol/cohort scope, as-of) gate verdict. The reporter's
--    "first_eligible_asof" is a MIN(as_of) WHERE passed query over this table.
create table if not exists public.replay_eligibility_events (
  id       bigint generated always as identity primary key,
  run_id   bigint not null references public.replay_eligibility_runs(id) on delete cascade,
  scope    text not null,                                    -- named symbol, or cohort name
  as_of    date not null,
  gate     text not null check (gate in ('calibration_oos','thin_evidence','ic','validation','breakdown_veto')),
  passed   boolean not null,
  margin   numeric,
  n_oos    int,
  ece      numeric,
  detail   jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists idx_replay_eligibility_events_run
  on public.replay_eligibility_events(run_id, scope, as_of);
create index if not exists idx_replay_eligibility_events_firstpass
  on public.replay_eligibility_events(run_id, scope, gate, as_of) where passed;

-- RLS: internal analyst tooling. Enable and restrict to service role by default; the
-- harness is server-side/offline only. (Matches the project's locked-down default for
-- internal tables; broaden deliberately if a dashboard needs read access.)
alter table public.replay_packets            enable row level security;
alter table public.replay_packet_items       enable row level security;
alter table public.replay_eligibility_runs   enable row level security;
alter table public.replay_eligibility_events enable row level security;
