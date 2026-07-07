-- Agent Mind feature. All tables service-role-only (read via owner-gated APIs).

-- Phase 1: prevent duplicate priors (this session found every row doubled).
-- Data already de-duped; this stops recurrence.
alter table learning_priors add constraint learning_priors_unique_principle unique (category, principle);

-- Phase 1: append-only history of prior confidence/enabled changes, so the
-- Beliefs panel and the Brain view can show belief drift over time.
create table if not exists learning_priors_history (
  id bigint generated always as identity primary key,
  prior_id bigint not null references learning_priors(id) on delete cascade,
  confidence double precision,
  enabled boolean,
  changed_at timestamptz not null default now(),
  changed_by text not null default 'user' check (changed_by in ('user','learner')),
  reason text
);
create index if not exists learning_priors_history_prior_idx on learning_priors_history(prior_id, changed_at desc);
alter table learning_priors_history enable row level security;
revoke all on table learning_priors_history from anon, authenticated;

-- Phase 3: cached daily macro-to-holdings interpretation.
create table if not exists macro_interpretations (
  id bigint generated always as identity primary key,
  date date not null,
  market text not null default 'us' check (market in ('us','india')),
  content text,
  model text,
  created_at timestamptz not null default now(),
  unique (date, market)
);
alter table macro_interpretations enable row level security;
revoke all on table macro_interpretations from anon, authenticated;
