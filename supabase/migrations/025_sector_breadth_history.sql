create table if not exists sector_breadth_history (
  id uuid primary key default gen_random_uuid(),
  date date not null,
  sector text not null,
  advance_count int not null default 0,
  decline_count int not null default 0,
  unchanged_count int not null default 0,
  breadth_pct numeric(5,2),
  top_contributors jsonb,
  created_at timestamptz default now(),
  unique(date, sector)
);
create index if not exists sector_breadth_history_idx on sector_breadth_history(date desc, sector);
