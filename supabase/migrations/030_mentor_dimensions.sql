-- Mentor behavior dimension scores per evaluation
create table if not exists mentor_dimension_logs (
  id              bigserial primary key,
  journal_entry_id uuid references trade_journal(id) on delete cascade,
  trade_symbol    text not null,
  evaluated_at    date not null default current_date,
  -- 6 behavior dimensions scored 0-100
  sector_awareness      int not null default 50,
  emotional_discipline  int not null default 50,
  risk_management       int not null default 50,
  thesis_quality        int not null default 50,
  entry_timing          int not null default 50,
  big_picture           int not null default 50,
  -- per-dimension coach observations (jsonb)
  observations    jsonb default '{}'::jsonb,
  created_at      timestamptz default now()
);

alter table mentor_dimension_logs disable row level security;

create index if not exists mentor_dim_date_idx on mentor_dimension_logs(evaluated_at);
create index if not exists mentor_dim_entry_idx on mentor_dimension_logs(journal_entry_id);
