create table if not exists paper_nav_history (
  id uuid primary key default gen_random_uuid(),
  date date not null unique,
  nav numeric(12,2) not null,
  cash_balance numeric(12,2),
  open_positions int default 0,
  realized_pnl numeric(12,2) default 0,
  created_at timestamptz default now()
);

create index if not exists paper_nav_history_date_idx on paper_nav_history(date desc);
