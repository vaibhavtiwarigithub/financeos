-- Agent config: per-agent LLM model selector (admin-controllable without code deploy)
create table if not exists agent_config (
  agent_name  text primary key,
  model       text not null default 'deepseek-chat',
  enabled     boolean not null default true,
  max_tokens  int not null default 2048,
  temperature float not null default 0.3,
  notes       text,
  updated_at  timestamptz default now()
);

alter table agent_config disable row level security;

insert into agent_config (agent_name, model, notes) values
  ('research',       'llama-3.3-70b-versatile', 'Groq free — AV data synthesis'),
  ('learner',        'deepseek-chat',            'DeepSeek V3 tool-use — pattern analysis'),
  ('deepseek',       'deepseek-chat',            'Cheap alternative signal generator'),
  ('theme-scout',    'deepseek-chat',            'Weekly theme summarization'),
  ('briefing',       'llama-3.3-70b-versatile',  'Daily morning/evening summaries (free)'),
  ('macro-sentinel', 'deepseek-chat',            'Macro indicator synthesis'),
  ('mentor',         'deepseek-chat',            'Trade thesis evaluation')
on conflict (agent_name) do nothing;

-- Learner runs: stores per-run reasoning chain + Mermaid diagram
create table if not exists learner_runs (
  id               bigserial primary key,
  run_date         date not null unique,
  signals_analyzed int default 0,
  trades_analyzed  int default 0,
  hypotheses       jsonb default '[]'::jsonb,
  weight_mutations jsonb default '[]'::jsonb,
  reasoning_chain  jsonb default '[]'::jsonb,
  mermaid_per_run  text,
  model_used       text,
  win_rate_snapshot float,
  tokens_in        int default 0,
  tokens_out       int default 0,
  created_at       timestamptz default now()
);

alter table learner_runs disable row level security;
create index if not exists learner_runs_date_idx on learner_runs(run_date desc);
