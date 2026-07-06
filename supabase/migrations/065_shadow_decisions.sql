-- Phase 3 learning-core: shadow A/B. Up to 3 strategy_versions per market may
-- sit in state='shadow_paper' — ResearchAgent records what EACH would have
-- decided (pure scoring replay, no fills/cash) alongside the champion's real
-- decision. Off by default: no version enters shadow_paper unless a human (or
-- the bounded weekly auto-promotion, gated by strategy_config.exploration_
-- enabled) puts it there.

alter table strategy_versions drop constraint if exists strategy_versions_state_check;
alter table strategy_versions add constraint strategy_versions_state_check
  check (state = any (array['draft','testing','rejected','paper_candidate','paper_active','paper_paused','eligible','approved_live','live_paused','retired','shadow_paper']));

create table if not exists shadow_decisions (
  id                 bigserial primary key,
  ts                 timestamptz not null default now(),
  market             text not null default 'us',
  symbol             text not null,
  observation_id     bigint references decision_observations(id) on delete cascade,
  policy_version_id  bigint not null references strategy_versions(id),
  would_enter        boolean not null default false,
  score              numeric not null,
  size_pct           numeric,
  entry_price        numeric
);

alter table shadow_decisions disable row level security;
create index if not exists shadow_policy_idx on shadow_decisions(policy_version_id, ts desc);
create index if not exists shadow_obs_idx on shadow_decisions(observation_id);

-- Paper-only exploration budget: at most ONE challenger may auto-enter
-- shadow_paper per week (the learner's best-validated challenger). Default off.
alter table strategy_config add column if not exists exploration_enabled boolean default false;
