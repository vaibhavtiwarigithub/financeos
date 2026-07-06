-- Phase 3 learning-core: governed feature discovery. LLM code/prose NEVER
-- executes — only a whitelisted expression grammar (see lib/validation/
-- feature-compiler.ts) over keys already present in decision_observations.features.

create table if not exists feature_registry (
  id            bigserial primary key,
  name          text not null unique,
  spec          jsonb not null,   -- {rationale, formula, inputs, lag_days, expected_sign, horizon, universe, falsification_test}
  status        text not null default 'proposed' check (status in ('proposed','quarantined','active','retired')),
  proposed_by   text default 'learner',
  ic_history    jsonb default '[]'::jsonb,
  created_at    timestamptz default now(),
  updated_at    timestamptz default now()
);

alter table feature_registry disable row level security;
create index if not exists freg_status_idx on feature_registry(status);
