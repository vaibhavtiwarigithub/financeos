-- Morning/evening briefings table
create table if not exists briefings (
  id          uuid primary key default gen_random_uuid(),
  date        date not null,
  session     text not null check (session in ('morning', 'evening')),
  content     text not null,
  model       text,
  created_at  timestamptz default now(),
  unique (date, session)
);

alter table briefings enable row level security;
create policy "service_all" on briefings for all using (true);
