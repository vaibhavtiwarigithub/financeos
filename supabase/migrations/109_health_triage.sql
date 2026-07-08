-- Self-healing Part B: health-triage agent (read-only LLM SRE).
-- Stores one plain-English triage per run over the current open issues + recent errors +
-- data-quality/provider/broker health. Advisory ONLY — it never changes config, weights,
-- orders, or code (that boundary is enforced in the route: no write path is exposed to it).

create table if not exists health_triage (
  id bigserial primary key,
  ts timestamptz not null default now(),
  content text not null,
  model text,
  open_alerts int,
  critical_alerts int,
  tokens_input int,
  tokens_output int
);

-- Deny-by-default: owner reads via the service client in an owner-gated route.
alter table health_triage enable row level security;
revoke all on table health_triage from anon, authenticated;

-- Model is owner-selectable in Settings -> Agents -> LLM Config (same as macro-read/mentor).
-- Default to a cheap advisory model. Seed only if absent (no reliance on a unique constraint).
insert into agent_config (agent_name, model, enabled)
select 'health-triage', 'deepseek-v4-flash', true
where not exists (select 1 from agent_config where agent_name = 'health-triage');
