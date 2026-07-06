-- Phase 1 learning-core: immutable point-in-time decision ledger.
-- One row per candidate scored by ResearchAgent (filled OR rejected).
-- NEVER updated after insert. Labels live in observation_labels (060).

create table if not exists decision_observations (
  id                bigserial primary key,
  ts                timestamptz not null default now(),
  market            text not null default 'us',           -- 'us' | 'india'
  symbol            text not null,
  -- versioning / provenance
  code_version      text,                                  -- git sha or build id, nullable
  strategy_version_id bigint,                              -- FK-ish to strategy_versions.id (no hard FK; champion may be absent)
  weights_used      jsonb,                                 -- {fundamental:0.3,...} actually used this scoring
  used_champion     boolean not null default false,
  -- point-in-time features
  features          jsonb not null,                        -- computeScores().evidence blob (raw sub-features per dimension)
  availability_mask jsonb,                                 -- {fundamental:true, technical:true, sentiment:false, macro:true, insider:false}
  -- scores
  analyst_score     numeric not null,
  fundamental_score numeric, technical_score numeric, sentiment_score numeric,
  macro_score numeric, insider_score numeric,
  direction         text,                                  -- long|short|hold as scored
  -- decision
  entry_eligible    boolean not null default false,        -- analyst_score >= threshold AND direction='long'
  action            text not null default 'scored',        -- 'scored' | 'signal_written' | 'skipped_<reason>'
  score_threshold   numeric,                               -- threshold in force at decision time
  price_at_decision numeric,                               -- close/quote used at scoring time, in native currency
  currency          text not null default 'USD',
  signal_id         uuid                                    -- agent_signals.id when a signal row was written
);

alter table decision_observations disable row level security;
create index if not exists dobs_symbol_ts_idx on decision_observations(symbol, ts desc);
create index if not exists dobs_market_ts_idx on decision_observations(market, ts desc);
create index if not exists dobs_unlabeled_idx on decision_observations(ts) where signal_id is not null or entry_eligible = true;

-- Block mutation: ledger is append-only.
create or replace function dobs_block_mutation() returns trigger language plpgsql as $$
begin
  raise exception 'decision_observations is append-only';
end $$;
drop trigger if exists dobs_no_update on decision_observations;
create trigger dobs_no_update before update or delete on decision_observations
  for each row execute function dobs_block_mutation();
