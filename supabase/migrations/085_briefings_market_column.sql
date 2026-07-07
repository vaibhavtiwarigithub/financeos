-- Briefings (morning/evening email) were US-only and ET-anchored with no
-- market column at all — India never got its own brief. Adding market so a
-- US and an India brief can coexist for the same date/session without
-- clobbering each other via the (date,session) unique constraint.

alter table public.briefings add column if not exists market text not null default 'us' check (market in ('us', 'india'));

alter table public.briefings drop constraint if exists briefings_date_session_key;
alter table public.briefings add constraint briefings_date_session_market_key unique (date, session, market);

alter table public.newsletters add column if not exists market text check (market in ('us', 'india'));
