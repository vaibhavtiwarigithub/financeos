-- Weekly macro indicator readings
create table if not exists macro_signals (
  id bigserial primary key,
  week_of date not null,
  indicator text not null,
  value numeric(12,4),
  signal text not null, -- 'green' | 'yellow' | 'orange' | 'red'
  description text,
  created_at timestamptz default now()
);
create index if not exists macro_signals_week_idx on macro_signals(week_of desc);
create unique index if not exists macro_signals_week_indicator_idx on macro_signals(week_of, indicator);

-- Weekly regime assessment
create table if not exists macro_regime (
  id bigserial primary key,
  week_of date not null unique,
  danger_score int not null default 0,
  regime text not null default 'green', -- 'green' | 'yellow' | 'orange' | 'red'
  signals_triggered int not null default 0,
  ai_bubble_score int not null default 0,
  summary text,
  raw_indicators jsonb,
  created_at timestamptz default now()
);
