-- newsletters: saved morning/evening email editions
create table if not exists newsletters (
  id          uuid primary key default gen_random_uuid(),
  edition     text not null,        -- 'morning' | 'evening'
  subject     text,
  html_body   text,
  data_snapshot jsonb,              -- raw data used to build email (for debugging)
  sent_to     text,
  resend_id   text,                 -- Resend API message ID
  nav_at_send numeric(12,2),
  signals_count int default 0,
  positions_count int default 0,
  sent_at     timestamptz default now(),
  created_at  timestamptz default now()
);

alter table newsletters disable row level security;
create index if not exists newsletters_edition_idx on newsletters(edition, sent_at desc);
create index if not exists newsletters_sent_idx on newsletters(sent_at desc);
