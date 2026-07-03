-- Phase 2: Strategy Registry — versioned strategy definitions + experiment results

create table if not exists strategy_versions (
  id              bigserial primary key,
  version         text not null,         -- e.g. 'v1.0.0', 'v1.1.0-challenger'
  name            text not null,
  description     text,
  -- Hypothesis definition (immutable once frozen)
  universe        text not null default 'us_equity_etf',
  horizon_days_min integer not null default 2,
  horizon_days_max integer not null default 20,
  direction       text not null default 'long',
  -- Entry / exit rules (jsonb — flexible)
  entry_rules     jsonb,  -- e.g. {"analyst_score_min": 65, "rsi_min": 50, "price_vs_ema50": "above"}
  exit_rules      jsonb,  -- e.g. {"stop_loss_pct": 7, "target_pct": 20, "max_days": 15}
  -- Feature weights snapshot at time of creation
  weights_snapshot jsonb, -- {fundamental: 0.30, technical: 0.25, ...}
  -- Lifecycle
  state           text not null default 'draft' check (state in ('draft','testing','rejected','paper_candidate','paper_active','paper_paused','eligible','approved_live','live_paused','retired')),
  parent_version_id bigint references strategy_versions(id),
  -- Governance
  is_champion     boolean not null default false,
  promoted_at     timestamptz,
  retired_at      timestamptz,
  rejection_reason text,
  -- Metadata
  created_at      timestamptz default now(),
  notes           text
);

alter table strategy_versions disable row level security;
create index if not exists sv_state_idx on strategy_versions(state, created_at desc);
create index if not exists sv_champion_idx on strategy_versions(is_champion) where is_champion = true;

-- Experiment runs: backtests and paper-performance reports
create table if not exists experiment_runs (
  id              bigserial primary key,
  strategy_version_id bigint references strategy_versions(id),
  run_type        text not null,  -- 'backtest' | 'paper_eval' | 'eligibility_check'
  -- Dataset
  dataset_from    date,
  dataset_to      date,
  symbol_universe text[],
  signal_count    integer,
  -- Core metrics
  win_rate        numeric(6,4),   -- 0–1
  avg_return_pct  numeric(8,4),
  median_return_pct numeric(8,4),
  max_drawdown_pct numeric(8,4),
  sharpe_ratio    numeric(8,4),
  expectancy      numeric(8,4),   -- avg_win * win_rate - avg_loss * (1 - win_rate)
  -- Benchmark comparison
  benchmark_symbol text default 'SPY',
  benchmark_return_pct numeric(8,4),
  alpha_pct       numeric(8,4),   -- vs benchmark
  -- Eligibility gate results
  gate_pass       boolean,
  gate_reasons    jsonb,          -- per-criterion pass/fail
  -- Full metrics blob
  metrics_json    jsonb,
  -- Status
  status          text not null default 'running' check (status in ('running','complete','failed')),
  error_message   text,
  -- Reproducibility
  code_version    text,
  config_snapshot jsonb,
  created_at      timestamptz default now(),
  completed_at    timestamptz
);

alter table experiment_runs disable row level security;
create index if not exists er_strategy_idx on experiment_runs(strategy_version_id, created_at desc);
create index if not exists er_gate_idx on experiment_runs(gate_pass, run_type);

-- Add strategy_version_id to agent_signals for tracking which version produced signal
alter table agent_signals add column if not exists strategy_version_id bigint;

-- Paper benchmark: track SPY NAV alongside paper NAV
alter table paper_performance add column if not exists spy_nav numeric(14,2);
alter table paper_performance add column if not exists spy_return_pct numeric(8,4);
alter table paper_performance add column if not exists alpha_pct numeric(8,4);

-- Seed initial strategy version (our current Phase 0 approach)
insert into strategy_versions (
  version, name, description, universe, horizon_days_min, horizon_days_max, direction,
  entry_rules, exit_rules,
  weights_snapshot,
  state, is_champion, notes
) values (
  'v1.0.0',
  'Phase0-Baseline',
  'Dual-bucket screener with deterministic 5-factor scoring. Momentum: RSI>60 + price>EMA50 + revenue growth. Value: P/E<18 + FCF + insider buying.',
  'us_equity_etf',
  2, 20, 'long',
  '{"analyst_score_min": 60, "rsi_min": 50, "price_vs_ema50": "above"}'::jsonb,
  '{"stop_loss_pct": 7, "target_pct": 20, "max_days": 15}'::jsonb,
  '{"fundamental": 0.30, "technical": 0.25, "sentiment": 0.20, "macro": 0.15, "insider": 0.10}'::jsonb,
  'paper_active',
  true,
  'Phase 0 baseline — champion until challenger is validated'
) on conflict do nothing;
