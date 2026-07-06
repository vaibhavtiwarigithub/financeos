-- Part C (Decision 38): goal tracker — a MEASURED dashboard only, never an
-- agent input (return targets are never wired into sizing/threshold).
create table if not exists trading_goals (
  id bigserial primary key,
  created_at timestamptz not null default now(),
  market text not null default 'us',
  target_return_pct numeric not null,
  horizon_days int not null,
  start_nav numeric not null,
  start_date date not null default current_date,
  status text not null default 'active', -- active|achieved|missed|canceled
  note text
);
comment on table trading_goals is 'READ BY UI ONLY — never an agent input (see Decision 34)';
