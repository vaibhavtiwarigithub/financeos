-- Phase 1 learning-core: forward-outcome labels, computed ONLY after horizon maturity.
-- Separate table so features (059) can never see the future.

create table if not exists observation_labels (
  id               bigserial primary key,
  observation_id   bigint not null references decision_observations(id) on delete cascade,
  horizon_days     int not null,                    -- 2 | 5 | 10 | 20 (trading days)
  fwd_return       numeric,                         -- (exit_px - entry_px)/entry_px, cost-adjusted
  benchmark_return numeric,                         -- same-window benchmark return (SPY for us, ^NSEI for india)
  benchmark_neutral_return numeric,                 -- fwd_return - benchmark_return
  max_adverse_excursion numeric,                    -- min((low_t - entry)/entry) over window  (<= 0)
  max_favorable_excursion numeric,                  -- max((high_t - entry)/entry) over window (>= 0)
  entry_price      numeric,                         -- price_at_decision used as entry basis
  exit_price       numeric,
  matured_at       timestamptz not null default now(),
  unique (observation_id, horizon_days)
);

alter table observation_labels disable row level security;
create index if not exists olab_obs_idx on observation_labels(observation_id);
