-- Decision 40: Research Journal — per-symbol pipeline stage trail + feature
-- registry status history.
create table if not exists pipeline_stage_events (
  id bigserial primary key,
  signal_id uuid not null,
  symbol text not null,
  market text not null default 'us',
  stage text not null, -- 'research' | 'portfolio_constructor' | 'proposal' | 'execution'
  outcome text not null, -- 'passed' | 'rejected' | 'shrunk' | 'filled' | 'expired'
  reason text,
  detail jsonb,
  created_at timestamptz not null default now()
);
create index if not exists idx_pipeline_stage_events_signal on pipeline_stage_events(signal_id);
create index if not exists idx_pipeline_stage_events_date on pipeline_stage_events(created_at);

create table if not exists feature_registry_history (
  id bigserial primary key,
  feature_id bigint not null,
  from_status text,
  to_status text not null,
  reason text,
  created_at timestamptz not null default now()
);
