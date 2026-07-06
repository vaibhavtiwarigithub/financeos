-- Ops spec Part 3 (Decision 39): fortnightly model-freshness check results.
create table if not exists model_check_results (
  id bigserial primary key,
  checked_at timestamptz not null default now(),
  findings jsonb not null default '[]'::jsonb,
  providers_ok jsonb not null default '{}'::jsonb
);
