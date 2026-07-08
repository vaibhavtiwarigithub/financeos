-- Learning Integrity Phase 1B: taint columns on paper_trades and broker_orders.
--
-- These five additive columns let PaperTrader and Execution Gateway stamp each
-- trade at creation time with the quality of the decision that produced it.
-- Source of truth: v_decision_quality joined by signal_id.
--
-- Measure-only on launch: tainted/excluded_from_learning are written but the
-- learner/validation dataset filters are not yet enforced. Enforcement turns on
-- after golden tests and historical flag-rate review pass (see FEATURE_ARCHITECTURE).
--
-- NEVER delete or mutate decision_observations, observation_labels, shadow_decisions,
-- paper_order_events, learning_log, or strategy_versions.

alter table paper_trades
  add column if not exists data_confidence   numeric,
  add column if not exists quality_status    text,
  add column if not exists tainted           boolean default false,
  add column if not exists taint_reason      text,
  add column if not exists excluded_from_learning boolean default false;

alter table broker_orders
  add column if not exists data_confidence   numeric,
  add column if not exists quality_status    text,
  add column if not exists tainted           boolean default false,
  add column if not exists taint_reason      text,
  add column if not exists excluded_from_learning boolean default false;

comment on column paper_trades.data_confidence       is 'Fraction of structurally applicable scoring dimensions covered by real data at decision time. From v_decision_quality.';
comment on column paper_trades.quality_status        is 'ok | unknown. unknown = malformed base_weights or missing availability_mask; never auto-tainted during measure-only phase.';
comment on column paper_trades.tainted               is 'True when data_confidence < 0.5 AND quality_status = ok. Measure-only: written but not yet enforced as a learner filter.';
comment on column paper_trades.taint_reason          is 'Human-readable explanation of which dims were missing/degraded.';
comment on column paper_trades.excluded_from_learning is 'Learner and validation engine must skip this row. Set by auto-taint or owner override.';

comment on column broker_orders.data_confidence       is 'Same as paper_trades.data_confidence. Joined via proposal_id -> trade_proposals -> signal_id.';
comment on column broker_orders.quality_status        is 'ok | unknown. See paper_trades.quality_status.';
comment on column broker_orders.tainted               is 'True when data_confidence < 0.5 AND quality_status = ok.';
comment on column broker_orders.taint_reason          is 'Which dims were missing/degraded.';
comment on column broker_orders.excluded_from_learning is 'Learner must skip. Set by auto-taint or owner override.';

-- Partial index so the PaperTrader back-fill query is fast.
create index if not exists idx_paper_trades_tainted
  on paper_trades (tainted, excluded_from_learning)
  where tainted = true or excluded_from_learning = true;
