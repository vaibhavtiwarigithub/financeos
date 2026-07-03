-- Fix learner_config: add missing columns, fix dimension names, seed informed weights

-- Add missing columns
alter table learner_config add column if not exists weight float not null default 0.20;
alter table learner_config add column if not exists last_rationale text;
alter table learner_config add column if not exists last_updated_at timestamptz;

-- Rename _score suffix rows to bare dimension names (learner-agent uses bare names)
update learner_config set dimension = 'fundamental' where dimension = 'fundamental_score';
update learner_config set dimension = 'technical'   where dimension = 'technical_score';
update learner_config set dimension = 'sentiment'   where dimension = 'sentiment_score';
update learner_config set dimension = 'macro'       where dimension = 'macro_score';
update learner_config set dimension = 'insider'     where dimension = 'insider_score';

-- Seed informed starting weights (from original spec: sums to 1.0)
-- Technical highest: RSI/EMA most predictive for short-term momentum
-- Insider lowest but high confidence when present (sparse data)
insert into learner_config (dimension, weight, learn_from, allow_mutation, min_confidence, notes) values
  ('fundamental', 0.25, true, true, 0.70, 'FCF yield, P/E vs sector, revenue acceleration'),
  ('technical',   0.30, true, true, 0.70, 'RSI, EMA crosses — highest short-term predictive'),
  ('sentiment',   0.20, true, true, 0.75, 'Noisy — higher confidence gate before mutation'),
  ('macro',       0.15, true, true, 0.70, 'Rate regime, VIX, yield curve context'),
  ('insider',     0.10, true, true, 0.65, 'Sparse but high-conviction — lower gate')
on conflict (dimension) do update
  set weight         = excluded.weight,
      min_confidence = excluded.min_confidence,
      notes          = excluded.notes,
      updated_at     = now();

-- Snapshot initial weights in history for rollback baseline
insert into signal_weights_history (
  snapshot_at, run_date, trigger,
  fundamental_weight, technical_weight, sentiment_weight, macro_weight, insider_weight,
  win_rate_at_time, notes
) values (
  now(), current_date, 'initial_seed',
  0.25, 0.30, 0.20, 0.15, 0.10,
  null, 'Informed Bayesian prior — from original spec. Technical weighted highest for short-term momentum.'
);
